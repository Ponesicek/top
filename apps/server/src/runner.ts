/**
 * One bot: a pi-agent-core `Agent` whose every step is saved before anything else happens.
 *
 * - A message from the inbox becomes an entry when the model takes it (one transaction moves it).
 * - An answer is saved when it ends. The Agent waits for that before it starts any tool call.
 * - A tool call is recorded right before the tool runs; its result is saved the moment it returns.
 * - A failed model request is retried with backoff; only the final failure is kept.
 *
 * After a crash, `recover()` settles every tool call left without a result according to the tool's
 * policy (see tools.ts) and the task continues. If the daemon keeps dying during one task, the task is
 * ended instead of looping forever.
 */
import { Agent, type AgentEvent, type AgentMessage, type AgentTool, type ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, getCurrentSystemMessage, type Models, type SystemMessage, type ToolResultMessage } from "@earendil-works/pi-ai";
import type { BotStatus } from "@top/protocol";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberHandle from "effect/FiberHandle";
import * as Latch from "effect/Latch";
import { type Attachments, userContent, withImageData } from "./attachments.ts";
import { type BotRow, type InboxRow, Store, type StoredEntry } from "./store.ts";
import { type ToolResult, type TopTool, text } from "./tools.ts";

/** A task may survive this many daemon restarts; the next one ends it. */
export const RESTART_LIMIT = 3;
/** Backoff before each retry of a failed model request (`TOP_RETRY_DELAYS_MS=100,100,100` shortens it for tests). */
export const RetryDelaysMs = Config.String("TOP_RETRY_DELAYS_MS").pipe(
  Config.map((value) => value.split(",").map(Number)),
  Config.withDefault([1_000, 4_000, 15_000]),
);

export type RunnerStatus = { readonly status: BotStatus; readonly tool?: string | undefined; readonly error?: string | undefined; readonly since: number };

export type RunnerOptions = {
  readonly thinkingLevel?: ThinkingLevel | undefined;
  /** Named system prompt sections the bot should have. A change is saved just before the next message the bot takes. */
  readonly sections?: Readonly<Record<string, string>> | undefined;
  /**
   * How long a message from Top itself (a job's result, a wake-up) waits before it starts a task for
   * an idle bot, so ones that come close together start one task, not one each.
   */
  readonly gatherMs?: number | undefined;
  /** Where the user's attachments are; without it, messages have none. */
  readonly attachments?: Attachments["Service"] | undefined;
  /** Backoff before each retry of a failed model request. */
  readonly retryDelaysMs?: readonly number[] | undefined;
};

/** See `RunnerOptions.gatherMs`. */
const GATHER_MS = 2_000;

export type RunnerEvents = {
  readonly entry: (entry: StoredEntry) => Effect.Effect<void>;
  readonly inbox: (bot: number) => Effect.Effect<void>;
  readonly status: (bot: number) => Effect.Effect<void>;
};

export type BotRunner = {
  readonly id: number;
  readonly name: string;
  /** The bot's current system prompt, as the model will see it (with any pending update). */
  readonly systemPrompt: () => SystemMessage | undefined;
  readonly status: () => RunnerStatus;
  /** Running a task, or about to. */
  readonly busy: () => boolean;
  readonly waitForIdle: Effect.Effect<void>;
  /** Start working: after `recover`, and whenever a message arrives. */
  readonly start: Effect.Effect<void>;
  /** A message was accepted into the inbox. */
  readonly submitted: (row: InboxRow) => Effect.Effect<void>;
  readonly abort: Effect.Effect<void>;
  /** Start nothing more on its own: the daemon is shutting down, or the bot is being deleted. */
  readonly close: Effect.Effect<void>;
  /**
   * Settle what the last process left unfinished. Run once at startup, before `start`.
   * Answers with a description of what was done, for the log.
   */
  readonly recover: Effect.Effect<string | undefined>;
};

type ToolCallPart = { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };

const toolCallsOf = (message: AssistantMessage): ToolCallPart[] => message.content.filter((part) => part.type === "toolCall") as unknown as ToolCallPart[];

function toolResultMessage(toolCallId: string, toolName: string, result: ToolResult, isError: boolean, timestamp: number): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: (result.content ?? []) as ToolResultMessage["content"],
    details: result.details,
    isError,
    timestamp,
  } as ToolResultMessage;
}

/**
 * One bot, running in the scope it's made in. `tools` is asked again at the start of every run, so
 * tools that come and go (an MCP server given to the bot, or one that connected) reach the model from
 * its next message. The Agent declares the difference in a system message, which is saved like any other.
 */
export const makeRunner = Effect.fnUntraced(function* (
  bot: BotRow,
  models: Models,
  toolSource: () => readonly TopTool[],
  events: RunnerEvents,
  options: RunnerOptions = {},
) {
  const store = yield* Store;
  const scope = yield* Effect.scope;
  // pi calls back with Promises (hooks, listeners, tools): they run the bot's Effects here.
  const runPromise = Effect.runPromiseWith(yield* Effect.context<Store>());
  const id = bot.id;
  const gatherMs = options.gatherMs ?? GATHER_MS;
  const retryDelays = options.retryDelaysMs ?? [1_000, 4_000, 15_000];
  const attachments = options.attachments;
  const now = Clock.currentTimeMillis;

  let busy = false;
  const idle = yield* Latch.make(true);
  /** requestId of each queued message object handed to the Agent. */
  const requestIds = new WeakMap<object, string>();
  /** requestIds handed to the Agent's queues in the current run. */
  const delivered = new Set<string>();
  /** The saved assistant message whose tool calls are running. */
  let assistantSeq = 0;
  /** A failed model request, held back until we know whether a retry succeeds. */
  let pendingError: AssistantMessage | undefined;
  let abortRequested = false;
  /** Ends the wait before a retry early: the user stopped the bot. */
  let wakeRetry: Deferred.Deferred<void> | undefined;
  let status: RunnerStatus = { status: "idle", since: yield* now };
  /** Prompt sections that changed since the transcript last said; saved with the next message taken. */
  let systemUpdate: SystemMessage | undefined;
  let tools = new Map<string, TopTool>();
  /** A task waiting to start on messages from Top, in case more come (see `RunnerOptions.gatherMs`). */
  const gather = yield* FiberHandle.make();

  // Split at the first slash only: model ids can contain one too (OpenRouter's "anthropic/claude-…").
  const slash = bot.model.indexOf("/");
  const model = models.getModel(bot.model.slice(0, slash), bot.model.slice(slash + 1));
  if (!model) return yield* Effect.die(new Error(`Bot ${bot.name}: unknown model ${bot.model}`));

  const key = (seq: number, toolCallId: string) => `${id}:${seq}:${toolCallId}`;

  const setStatus = (next: BotStatus, extra: { tool?: string | undefined; error?: string | undefined } = {}) =>
    Effect.gen(function* () {
      if (status.status === next && status.tool === extra.tool && status.error === extra.error) return;
      status = { status: next, ...extra, since: yield* now };
      yield* events.status(id);
    });

  const append = (kind: "assistant" | "system" | "notice", message: unknown) => Effect.tap(store.append(id, kind, message), (stored) => events.entry(stored));

  const agent = new Agent({
    // The stored transcript starts with the bot's system message, so the Agent adds none of its own.
    initialState: {
      model,
      thinkingLevel: options.thinkingLevel ?? "off",
      tools: [],
      messages: (yield* store.context(id)).map((e) => e.message as AgentMessage),
    },
    streamFn: models.streamSimple.bind(models),
    identity: { attribution: null },
    // Messages that queue up while the bot works reach it together, at one step.
    steeringMode: "all",
    followUpMode: "all",
    beforeToolCall: async ({ toolCall, args }) => {
      // Stop means stop: no tool starts after the user asked to stop, whatever the model wants.
      if (abortRequested) return { block: true, reason: "Not run: stopped by the user." };
      // Recorded before it runs: after a crash, a call with this record and no result may have taken effect.
      await runPromise(store.toolStarted(id, assistantSeq, toolCall.id, toolCall.name, args));
      return undefined;
    },
    // ...and no new model request starts after it either (tool results of the stopped turn are kept).
    finishTurn: async () => (abortRequested ? { action: "end" } : undefined),
    // Images are stored as their attachment's id; each request reads them in (attachments.ts).
    ...(attachments ? { transformContext: (messages: AgentMessage[]) => runPromise(withImageData(messages, attachments)) } : {}),
  });

  const userMessage = (row: InboxRow): AgentMessage => {
    const message = (
      row.attachments.length && attachments
        ? {
            role: "user",
            content: userContent(row.text, row.attachments, (a) => attachments.path(a)),
            attachments: row.attachments,
            timestamp: row.at,
          }
        : { role: "user", content: row.text, timestamp: row.at }
    ) as AgentMessage;
    requestIds.set(message, row.requestId);
    return message;
  };

  const deliver = (row: InboxRow) => {
    if (delivered.has(row.requestId)) return;
    delivered.add(row.requestId);
    const message = userMessage(row);
    if (row.mode === "steer") agent.steer(message);
    else agent.followUp(message);
  };

  const saveMessage = (message: AgentMessage) =>
    Effect.gen(function* () {
      switch (message.role) {
        case "user": {
          const requestId = requestIds.get(message);
          const stored = requestId ? yield* store.place(id, requestId, message) : yield* store.append(id, "user", message);
          yield* events.entry(stored);
          if (requestId) yield* events.inbox(id);
          return;
        }
        case "assistant": {
          const assistant = message as AssistantMessage;
          if (assistant.stopReason === "error") {
            pendingError = assistant;
            return;
          }
          const stored = yield* append("assistant", assistant);
          assistantSeq = stored.seq;
          if (!toolCallsOf(assistant).length && assistant.stopReason !== "aborted") yield* store.setRestarts(id, 0);
          return;
        }
        case "toolResult":
          return; // saved at tool_execution_end, the moment the tool returned
        case "system":
          yield* append("system", message);
          return;
      }
    });

  const onEvent = (event: AgentEvent) =>
    Effect.gen(function* () {
      switch (event.type) {
        case "message_start":
          if (event.message.role === "assistant") yield* setStatus("thinking");
          return;
        case "message_end":
          return yield* saveMessage(event.message);
        case "tool_execution_start":
          return yield* setStatus("tool", { tool: event.toolName });
        case "tool_execution_end": {
          const message = toolResultMessage(event.toolCallId, event.toolName, event.result as ToolResult, event.isError, yield* now);
          const stored = yield* store.toolFinished(id, assistantSeq, event.toolCallId, message);
          // A tool that really ran to completion is progress; settled-after-crash results are not.
          if (event.durationMs !== undefined) yield* store.setRestarts(id, 0);
          yield* events.entry(stored);
          if (!agent.state.pendingToolCalls.size) yield* setStatus("thinking");
          return;
        }
      }
    });
  // pi waits for the listener before it goes on: every step is saved before the next one starts.
  agent.subscribe((event) => runPromise(onEvent(event)));

  /** Take the bot's tools as they are now. Between runs only: a run keeps the tools it started with. */
  const refreshTools = () => {
    const current = toolSource();
    tools = new Map(current.map((tool) => [tool.name, tool]));
    agent.state.tools = current.map(
      (tool): AgentTool => ({
        name: tool.name,
        label: tool.label,
        description: tool.description,
        parameters: tool.parameters as AgentTool["parameters"],
        replay: tool.replay ?? "never",
        ...(tool.prepareArguments ? { prepareArguments: tool.prepareArguments } : {}),
        ...(tool.executionMode ? { executionMode: tool.executionMode } : {}),
        execute: (toolCallId, params, signal) =>
          runPromise(tool.run(params as Record<string, unknown>, { key: key(assistantSeq, toolCallId), bot: id, signal })),
      }),
    );
  };
  refreshTools();

  {
    const current = getCurrentSystemMessage(agent.state.messages as never)?.sections ?? {};
    const changed = Object.entries(options.sections ?? {}).filter(([name, value]) => current[name] !== value);
    if (changed.length) systemUpdate = { role: "system", content: "", sections: Object.fromEntries(changed), timestamp: yield* now };
  }

  /** Set by the event listener while the Agent runs, so read it through a call TypeScript can't narrow. */
  const takePendingError = (): AssistantMessage | undefined => {
    const failed = pendingError;
    pendingError = undefined;
    return failed;
  };

  /** One run of the agent loop, with retries. False if something unexpected broke and driving should stop. */
  const run = (startRun: () => Promise<void>, queued: readonly InboxRow[], prompted: readonly InboxRow[] = []) =>
    Effect.gen(function* () {
      refreshTools();
      agent.clearAllQueues();
      delivered.clear();
      for (const row of prompted) delivered.add(row.requestId);
      for (const row of queued) deliver(row);
      abortRequested = false;
      pendingError = undefined;
      yield* store.setRunActive(id, true);
      yield* setStatus("thinking");
      const ok = yield* Effect.gen(function* () {
        yield* Effect.tryPromise(startRun);
        for (let attempt = 0; ; attempt++) {
          const failed = takePendingError();
          if (!failed) break;
          const delay = retryDelays[attempt];
          if (abortRequested || delay === undefined) {
            yield* append("assistant", failed);
            yield* setStatus("failed", { error: failed.errorMessage ?? "The model request failed" });
            break;
          }
          // Drop the failed attempt and ask again after a backoff.
          const messages = agent.state.messages;
          if (messages.at(-1) === failed) messages.pop();
          yield* setStatus("retrying", { error: failed.errorMessage });
          const wake = yield* Deferred.make<void>();
          wakeRetry = wake;
          yield* Effect.raceFirst(Effect.sleep(Duration.millis(delay)), Deferred.await(wake));
          wakeRetry = undefined;
          if (abortRequested) {
            yield* append("assistant", { ...failed, stopReason: "aborted", errorMessage: "Stopped" });
            break;
          }
          for (const row of yield* store.inbox(id)) deliver(row);
          yield* setStatus("thinking");
          yield* Effect.tryPromise(() => agent.continue());
        }
        // A stop that landed between steps leaves no aborted answer behind; say so in the transcript.
        const last = agent.state.messages.at(-1);
        if (abortRequested && !(last?.role === "assistant" && (last as AssistantMessage).stopReason === "aborted")) {
          yield* append("notice", { text: "Stopped" });
        }
        return true;
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.gen(function* () {
                yield* Effect.logError(`[${bot.name}] run failed`, cause);
                const error = Cause.squash(cause);
                const cause_ = error instanceof Error && error.cause instanceof Error ? error.cause : error;
                yield* setStatus("failed", { error: cause_ instanceof Error ? cause_.message : String(cause_) });
                return false;
              }),
        ),
      );
      // Not when the daemon is stopping (interrupted above): the task is still running, and resumes when it starts.
      yield* store.setRunActive(id, false);
      return ok;
    });

  const drive = Effect.gen(function* () {
    for (;;) {
      const tail = agent.state.messages.at(-1);
      const resumable = (tail?.role === "user" || tail?.role === "toolResult") && (yield* store.bot(id))?.runActive === true;
      const inbox = yield* store.inbox(id);
      if (resumable) {
        if (!(yield* run(() => agent.continue(), inbox))) break;
        continue;
      }
      if (!inbox.length) break;
      // Everything waiting goes in together: one task for several jobs that ended while it was idle.
      const messages = inbox.map(userMessage);
      // A prompt change goes in just before the messages, in the same run, so it's saved with them.
      const update = systemUpdate;
      systemUpdate = undefined;
      if (!(yield* run(() => agent.prompt(update ? [update, ...messages] : messages), [], inbox))) break;
    }
  }).pipe(
    Effect.ensuring(
      Effect.gen(function* () {
        busy = false;
        if (status.status !== "failed") yield* setStatus("idle");
        yield* idle.open;
      }),
    ),
  );

  const start = Effect.gen(function* () {
    yield* FiberHandle.clear(gather);
    if (busy) return;
    busy = true;
    yield* idle.close;
    yield* Effect.forkIn(drive, scope);
  });

  // ── recovery ─────────────────────────────────────────────────────────────────

  const settle = (call: ToolCallPart, seq: number, giveUp: boolean, restarts: number) =>
    Effect.gen(function* () {
      const record = yield* store.toolCall(seq, call.id);
      const tool = tools.get(call.name);
      const ctx = { key: key(seq, call.id), bot: id };
      const args = record ? (JSON.parse(record.args) as Record<string, unknown>) : call.arguments;
      let result: ToolResult;
      let isError = true;
      let outcome: string;
      if (giveUp) {
        outcome = "stopped";
        result = text(`Stopped: the daemon restarted ${restarts} times while this task ran, so it was ended. This tool may or may not have taken effect.`);
      } else if (!record) {
        outcome = "not_run";
        result = text("Not run: the daemon restarted before this tool started. Call it again if it is still needed.");
      } else if (tool?.replay === "safe") {
        outcome = "replayed";
        yield* setStatus("tool", { tool: call.name });
        const ran = yield* Effect.result(tool.run(args, ctx));
        if (ran._tag === "Success") {
          result = ran.success;
          isError = result.isError === true;
        } else {
          result = text(ran.failure.message);
        }
      } else {
        const recovered = tool?.recover ? yield* tool.recover(args, ctx).pipe(Effect.catchCause(() => Effect.undefined)) : undefined;
        if (recovered) {
          outcome = "recovered";
          result = recovered;
          isError = recovered.isError === true;
        } else if (recovered === false) {
          outcome = "not_run";
          result = text(
            "Did not take effect: the daemon restarted while this tool ran, and the tool confirmed it did not complete. Call it again if it is still needed.",
          );
        } else {
          outcome = "interrupted";
          result = text("Interrupted: the daemon restarted while this tool was running. It may or may not have taken effect. Check before calling it again.");
        }
      }
      const message = toolResultMessage(call.id, call.name, result, isError, yield* now);
      const stored = yield* store.toolFinished(id, seq, call.id, message, outcome);
      agent.state.messages.push(message);
      yield* events.entry(stored);
      return outcome;
    });

  const recover = Effect.gen(function* () {
    const row = (yield* store.bot(id))!;
    if (!row.runActive) return undefined;
    const restarts = row.restarts + 1;
    yield* store.setRestarts(id, restarts);
    const giveUp = restarts > RESTART_LIMIT;

    const messages = agent.state.messages;
    let assistantIndex = messages.length - 1;
    while (assistantIndex >= 0 && messages[assistantIndex]!.role === "toolResult") assistantIndex--;
    const assistant = messages[assistantIndex];
    const settled: string[] = [];
    if (assistant?.role === "assistant") {
      const seq = yield* store.lastAssistantSeq(id);
      const done = yield* store.toolResultsAfter(id, seq);
      for (const call of toolCallsOf(assistant as AssistantMessage)) {
        if (done.has(call.id)) continue;
        const outcome = yield* settle(call, seq, giveUp, restarts);
        settled.push(`${call.name}: ${outcome}`);
      }
    }
    if (giveUp) {
      yield* append("notice", { text: `Stopped this task: the daemon restarted ${restarts} times while it ran.` });
      yield* store.setRunActive(id, false);
      yield* store.setRestarts(id, 0);
      yield* setStatus("failed", { error: `Stopped after ${restarts} restarts` });
    }
    return `restart ${restarts}${giveUp ? " (task ended)" : ""}${settled.length ? `; ${settled.join(", ")}` : ""}`;
  });

  const runner: BotRunner = {
    id,
    name: bot.name,
    systemPrompt: () => {
      const messages = agent.state.messages as never as SystemMessage[];
      return getCurrentSystemMessage(systemUpdate ? [...messages, systemUpdate] : messages);
    },
    status: () => status,
    busy: () => busy,
    waitForIdle: idle.await,
    start,
    submitted: (row) =>
      Effect.suspend(() => {
        if (!busy) {
          // The user's starts a task now; Top's waits a moment for others (several jobs ending together).
          if (!row.source || !(gatherMs > 0)) return start;
          return Effect.asVoid(
            FiberHandle.run(gather, Effect.sleep(Duration.millis(gatherMs)).pipe(Effect.andThen(Effect.forkIn(start, scope))), { onlyIfMissing: true }),
          );
        }
        // Mid-run: hand it to the Agent so it lands at the next turn (steer) or when the task would end
        // (follow-up). Between runs, the next run picks it up from the inbox.
        if (agent.state.isStreaming) deliver(row);
        return Effect.void;
      }),
    abort: Effect.sync(() => {
      if (!busy) return;
      abortRequested = true;
      if (wakeRetry) Deferred.doneUnsafe(wakeRetry, Effect.void);
      agent.abort();
    }),
    close: FiberHandle.clear(gather),
    recover,
  };
  return runner;
});
