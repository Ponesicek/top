/**
 * One bot: Top's agent loop (loop.ts), with every step saved before anything else happens.
 *
 * - A message from the inbox becomes an entry when the model takes it (one transaction moves it).
 * - An answer is saved when it ends, before any of its tool calls start.
 * - A tool call is recorded right before the tool runs; its result is saved the moment it returns.
 * - A failed model request is retried with backoff; only the final failure is kept.
 *
 * After a crash, `recover()` settles every tool call left without a result according to the tool's
 * policy (see tools.ts) and the task continues. If the daemon keeps dying during one task, the task is
 * ended instead of looping forever.
 */
import { type AssistantMessage, getCurrentSystemMessage, type Models, type SystemMessage, type ToolCall } from "@earendil-works/pi-ai";
import type { BotStatus, ToolOutcome } from "@top/protocol";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberHandle from "effect/FiberHandle";
import * as Latch from "effect/Latch";
import { type Attachments, userContent, withImageData } from "./attachments.ts";
import { runLoop, type ThinkingLevel, toolCallsOf, toolResultMessage } from "./loop.ts";
import type { EntryBody, TopUserMessage, TranscriptMessage, UserText } from "./messages.ts";
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
  /**
   * Named system prompt sections the bot should have (`null`: none by that name), asked for again before
   * each message the bot takes between tasks. A change is saved just before that message.
   */
  readonly sections?: Effect.Effect<Readonly<Record<string, string | null>>> | undefined;
  /** Something to add to a message from the user when the bot takes it: the skill its `/<name>` asks for (see skills.ts). */
  readonly note?: ((text: string) => Effect.Effect<UserText | undefined>) | undefined;
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
   * Answers with a description of what was done, for the log. `planned`: the daemon restarted for an
   * update, which doesn't count toward `RESTART_LIMIT`.
   */
  readonly recover: (planned: boolean) => Effect.Effect<string | undefined>;
};

/**
 * One bot, running in the scope it's made in. `tools` is asked again at the start of every run, so
 * tools that come and go (an MCP server given to the bot, or one that connected) reach the model from
 * its next message. The loop declares the difference in a system message, which is saved like any other.
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
  const id = bot.id;
  const gatherMs = options.gatherMs ?? GATHER_MS;
  const retryDelays = options.retryDelaysMs ?? [1_000, 4_000, 15_000];
  const attachments = options.attachments;
  const now = Clock.currentTimeMillis;

  let busy = false;
  const idle = yield* Latch.make(true);
  /** The transcript, as the model sees it. */
  const messages: TranscriptMessage[] = yield* store.context(id);
  /** The loop is running: a message that comes now is handed to it, not left for the next run. */
  let looping = false;
  /** Messages for the loop's next turn, and for when it would finish. */
  let steering: TranscriptMessage[] = [];
  let followUps: TranscriptMessage[] = [];
  /** requestId of each message object handed to the loop. */
  const requestIds = new WeakMap<object, string>();
  /** requestIds handed to the loop in the current run. */
  const delivered = new Set<string>();
  /** Calls of the current answer that haven't ended. */
  let runningTools = 0;
  /** The saved assistant message whose tool calls are running. */
  let assistantSeq = 0;
  /** A failed model request, held back until we know whether a retry succeeds. */
  let pendingError: AssistantMessage | undefined;
  let abortRequested = false;
  /** Tells the current run's model request and tools to stop. */
  let stopRun: AbortController | undefined;
  /** Ends the wait before a retry early: the user stopped the bot. */
  let wakeRetry: Deferred.Deferred<void> | undefined;
  let status: RunnerStatus = { status: "idle", since: yield* now };
  /** Prompt sections that changed since the transcript last said; saved with the next message taken. */
  let systemUpdate: SystemMessage | undefined;
  let toolList: readonly TopTool[] = [];
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

  const append = <K extends "assistant" | "system" | "notice">(kind: K, message: EntryBody[K]) =>
    Effect.tap(store.append(id, kind, message), (stored) => events.entry(stored));

  const userMessage = (row: InboxRow): Effect.Effect<TopUserMessage> =>
    Effect.gen(function* () {
      // Only the user's own messages ask for skills; Top's (a job's result, a wake-up) are what they are.
      const note = !row.source && options.note ? yield* options.note(row.text) : undefined;
      const message: TopUserMessage =
        row.attachments.length && attachments
          ? {
              role: "user",
              content: [...userContent(row.text, row.attachments, (a) => attachments.path(a)), ...(note ? [note] : [])],
              attachments: row.attachments,
              timestamp: row.at,
            }
          : { role: "user", content: note ? [...(row.text.trim() ? [{ type: "text" as const, text: row.text }] : []), note] : row.text, timestamp: row.at };
      requestIds.set(message, row.requestId);
      return message;
    });

  const deliver = (row: InboxRow) =>
    Effect.gen(function* () {
      if (delivered.has(row.requestId)) return;
      delivered.add(row.requestId);
      const message = yield* userMessage(row);
      if (row.mode === "steer") steering.push(message);
      else followUps.push(message);
    });

  const saveMessage = (message: TranscriptMessage) =>
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
          if (message.stopReason === "error") {
            pendingError = message;
            return;
          }
          const stored = yield* append("assistant", message);
          assistantSeq = stored.seq;
          if (!toolCallsOf(message).length && message.stopReason !== "aborted") yield* store.setRestarts(id, 0);
          return;
        }
        case "toolResult":
          return; // saved the moment the tool returned (toolEnd)
        case "system":
          yield* append("system", message);
          return;
      }
    });

  /** Take the bot's tools as they are now. Between runs only: a run keeps the tools it started with. */
  const refreshTools = () => {
    toolList = toolSource();
    tools = new Map(toolList.map((tool) => [tool.name, tool]));
  };
  refreshTools();

  const take = <A>(queue: A[]) => queue.splice(0);

  /** One pass of the loop: from `prompts`, or on from where the transcript ends. */
  const loop = (signal: AbortSignal, prompts?: readonly TranscriptMessage[]) =>
    Effect.gen(function* () {
      looping = true;
      yield* runLoop(
        {
          models,
          model,
          thinkingLevel: options.thinkingLevel ?? "off",
          messages,
          tools: toolList,
          toolContext: (toolCallId) => ({ key: key(assistantSeq, toolCallId), bot: id }),
          signal,
          stopped: () => abortRequested,
          // Messages that queue up while the bot works reach it together, at one step.
          steering: () => take(steering),
          followUps: () => take(followUps),
          // Images are stored as their attachment's id; each request reads them in (attachments.ts).
          transformContext: attachments ? (context) => withImageData(context, attachments) : undefined,
          hooks: {
            added: saveMessage,
            asking: setStatus("thinking"),
            toolStart: (call) => {
              runningTools++;
              return setStatus("tool", { tool: call.name });
            },
            // Recorded before it runs: after a crash, a call with this record and no result may have taken effect.
            toolRunning: (call, args) => store.toolStarted(id, assistantSeq, call.id, call.name, args),
            toolEnd: (result, ran) =>
              Effect.gen(function* () {
                const stored = yield* store.toolFinished(id, assistantSeq, result.toolCallId, result);
                // A tool that really ran to completion is progress; settled-after-crash results are not.
                if (ran) yield* store.setRestarts(id, 0);
                yield* events.entry(stored);
                if (--runningTools === 0) yield* setStatus("thinking");
              }),
          },
        },
        prompts,
      );
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          looping = false;
          runningTools = 0;
        }),
      ),
    );

  /** Compare the sections the bot should have with what its transcript says, and hold any change for the next message it takes. */
  const updateSections = Effect.gen(function* () {
    if (!options.sections) return;
    const wanted = yield* options.sections;
    const current = getCurrentSystemMessage(messages)?.sections ?? {};
    const changed = Object.entries(wanted).filter(([name, value]) => (current[name] ?? null) !== value);
    systemUpdate = changed.length ? { role: "system", content: "", sections: Object.fromEntries(changed), timestamp: yield* now } : undefined;
  });
  yield* updateSections;

  /** Set by `saveMessage` while the loop runs, so read it through a call TypeScript can't narrow. */
  const takePendingError = (): AssistantMessage | undefined => {
    const failed = pendingError;
    pendingError = undefined;
    return failed;
  };

  /** One run of the agent loop, with retries. False if something unexpected broke and driving should stop. */
  const run = (prompts: readonly TranscriptMessage[] | undefined, queued: readonly InboxRow[], prompted: readonly InboxRow[] = []) =>
    Effect.gen(function* () {
      refreshTools();
      steering = [];
      followUps = [];
      delivered.clear();
      for (const row of prompted) delivered.add(row.requestId);
      for (const row of queued) yield* deliver(row);
      pendingError = undefined;
      yield* store.setRunActive(id, true);
      yield* setStatus("thinking");
      const controller = new AbortController();
      stopRun = controller;
      const ok = yield* Effect.gen(function* () {
        yield* loop(controller.signal, prompts);
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
          for (const row of yield* store.inbox(id)) yield* deliver(row);
          yield* setStatus("thinking");
          yield* loop(controller.signal);
        }
        // A stop that landed between steps leaves no aborted answer behind; say so in the transcript.
        const last = messages.at(-1);
        if (abortRequested && !(last?.role === "assistant" && last.stopReason === "aborted")) {
          yield* append("notice", { text: "Stopped" });
        }
        return true;
      }).pipe(
        // Interrupted (the daemon stopping, the bot deleted): the request and the tools are told to stop.
        Effect.onInterrupt(() => Effect.sync(() => controller.abort())),
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
      // The Stop was for this run; the next one (a message queued behind it) runs.
      abortRequested = false;
      return ok;
    }).pipe(Effect.withSpan("Runner.run", { attributes: { bot: bot.name } }));

  const drive = Effect.gen(function* () {
    for (;;) {
      const tail = messages.at(-1);
      const resumable = (tail?.role === "user" || tail?.role === "toolResult") && (yield* store.bot(id))?.runActive === true;
      const inbox = yield* store.inbox(id);
      if (resumable) {
        if (!(yield* run(undefined, inbox))) break;
        continue;
      }
      if (!inbox.length) break;
      // Everything waiting goes in together: one task for several jobs that ended while it was idle.
      const taken = yield* Effect.forEach(inbox, userMessage);
      // A prompt change goes in just before the messages, in the same run, so it's saved with them.
      yield* updateSections;
      const update = systemUpdate;
      systemUpdate = undefined;
      if (!(yield* run(update ? [update, ...taken] : taken, [], inbox))) break;
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
    abortRequested = false;
    yield* idle.close;
    yield* Effect.forkIn(drive, scope);
  });

  // ── recovery ─────────────────────────────────────────────────────────────────

  const settle = (call: ToolCall, seq: number, giveUp: boolean, restarts: number) =>
    Effect.gen(function* () {
      const record = yield* store.toolCall(seq, call.id);
      const tool = tools.get(call.name);
      const ctx = { key: key(seq, call.id), bot: id };
      const args = record ? record.args : call.arguments;
      let result: ToolResult;
      let isError = true;
      let outcome: ToolOutcome;
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
          const cutOff = tool?.cutOff ? ` ${tool.cutOff}` : "";
          result = text(
            `Interrupted: the daemon restarted while this tool was running. It may or may not have taken effect.${cutOff} Check before calling it again.`,
          );
        }
      }
      const message = toolResultMessage(call.id, call.name, result, isError, yield* now);
      const stored = yield* store.toolFinished(id, seq, call.id, message, outcome);
      messages.push(message);
      yield* events.entry(stored);
      return outcome;
    });

  const recover = Effect.fnUntraced(
    function* (planned: boolean) {
      const row = (yield* store.bot(id))!;
      if (!row.runActive) return undefined;
      // An update's restart is the user's doing, not a task that keeps crashing the daemon: it doesn't count.
      const restarts = planned ? row.restarts : row.restarts + 1;
      yield* store.setRestarts(id, restarts);
      const giveUp = restarts > RESTART_LIMIT;

      let assistantIndex = messages.length - 1;
      while (assistantIndex >= 0 && messages[assistantIndex]!.role === "toolResult") assistantIndex--;
      const assistant = messages[assistantIndex];
      const settled: string[] = [];
      if (assistant?.role === "assistant") {
        const seq = yield* store.lastAssistantSeq(id);
        const done = yield* store.toolResultsAfter(id, seq);
        for (const call of toolCallsOf(assistant)) {
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
      return `${planned ? "planned restart" : `restart ${restarts}`}${giveUp ? " (task ended)" : ""}${settled.length ? `; ${settled.join(", ")}` : ""}`;
    },
    Effect.withSpan("Runner.recover", { attributes: { bot: bot.name } }),
  );

  const runner: BotRunner = {
    id,
    name: bot.name,
    systemPrompt: () => getCurrentSystemMessage(systemUpdate ? [...messages, systemUpdate] : messages),
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
        // Mid-run: hand it to the loop so it lands at the next turn (steer) or when the task would end
        // (follow-up). Between runs, the next run picks it up from the inbox.
        return looping ? deliver(row) : Effect.void;
      }),
    abort: Effect.sync(() => {
      if (!busy) return;
      abortRequested = true;
      if (wakeRetry) Deferred.doneUnsafe(wakeRetry, Effect.void);
      stopRun?.abort();
    }),
    close: FiberHandle.clear(gather),
    recover,
  };
  return runner;
});
