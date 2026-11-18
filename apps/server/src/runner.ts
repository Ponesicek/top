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
import { contextTokens, kTokens, summaryMessage, WINDOW_SHARE } from "./compaction.ts";
import { type Compact, runLoop, type ThinkingLevel, toolCallsOf, toolResultMessage } from "./loop.ts";
import type { EntryBody, TopUserMessage, TranscriptMessage, UserText } from "./messages.ts";
import { type BotRow, type InboxRow, Store, type StoredEntry } from "./store.ts";
import { type ToolResult, type TopTool, text } from "./tools.ts";
import { permanentFailure } from "./websearch.ts";

export const RESTART_LIMIT = 3;
export const RetryDelaysMs = Config.String("TOP_RETRY_DELAYS_MS").pipe(
  Config.map((value) => value.split(",").map(Number)),
  Config.withDefault([1_000, 4_000, 15_000]),
);

export type RunnerStatus = {
  readonly status: BotStatus;
  readonly tool?: string | undefined;
  readonly error?: string | undefined;
  readonly searching?: boolean | undefined;
  readonly since: number;
};

export type RunnerOptions = {
  readonly thinkingLevel?: ThinkingLevel | undefined;
  readonly sections?: Effect.Effect<Readonly<Record<string, string | null>>> | undefined;
  readonly note?: ((text: string) => Effect.Effect<UserText | undefined>) | undefined;
  readonly gatherMs?: number | undefined;
  readonly attachments?: Attachments["Service"] | undefined;
  readonly retryDelaysMs?: readonly number[] | undefined;
  readonly compactAtTokens?: number | undefined;
  readonly webSearch?: Effect.Effect<boolean> | undefined;
};

export const cacheKey = (bot: number) => `top-bot-${bot}`;

const GATHER_MS = 2_000;

export type RunnerEvents = {
  readonly entry: (entry: StoredEntry) => Effect.Effect<void>;
  readonly inbox: (bot: number) => Effect.Effect<void>;
  readonly status: (bot: number) => Effect.Effect<void>;
};

export type BotRunner = {
  readonly id: number;
  readonly name: string;
  readonly systemPrompt: () => SystemMessage | undefined;
  readonly status: () => RunnerStatus;
  readonly busy: () => boolean;
  readonly waitForIdle: Effect.Effect<void>;
  readonly start: Effect.Effect<void>;
  readonly submitted: (row: InboxRow) => Effect.Effect<void>;
  readonly abort: Effect.Effect<void>;
  readonly close: Effect.Effect<void>;
  readonly recover: (planned: boolean) => Effect.Effect<string | undefined>;
};

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
  const messages: TranscriptMessage[] = yield* store.context(id);
  let looping = false;
  let steering: TranscriptMessage[] = [];
  const requestIds = new WeakMap<object, string>();
  const delivered = new Set<string>();
  let runningTools = 0;
  let assistantSeq = 0;
  let pendingError: AssistantMessage | undefined;
  let abortRequested = false;
  let stopRun: AbortController | undefined;
  let wakeRetry: Deferred.Deferred<void> | undefined;
  let status: RunnerStatus = { status: "idle", since: yield* now };
  let systemUpdate: SystemMessage | undefined;
  let toolList: readonly TopTool[] = [];
  let searchOn = false;
  let tools = new Map<string, TopTool>();
  const gather = yield* FiberHandle.make();

  const slash = bot.model.indexOf("/");
  const model = models.getModel(bot.model.slice(0, slash), bot.model.slice(slash + 1));
  if (!model) return yield* Effect.die(new Error(`Bot ${bot.name}: unknown model ${bot.model}`));

  const key = (seq: number, toolCallId: string) => `${id}:${seq}:${toolCallId}`;

  const window = model.contextWindow > 0 ? Math.floor(model.contextWindow * WINDOW_SHARE) : Number.POSITIVE_INFINITY;
  const compactAt = options.compactAtTokens && options.compactAtTokens > 0 ? Math.min(options.compactAtTokens, window) : undefined;
  const compact: Compact | undefined =
    compactAt === undefined
      ? undefined
      : {
          atTokens: compactAt,
          save: (summary, keep, answer, tokensBefore) =>
            Effect.gen(function* () {
              const at = yield* now;
              const cut = messages.length - keep;
              const baseline = getCurrentSystemMessage(messages.slice(0, cut));
              const after = contextTokens([...(baseline ? [baseline] : []), summaryMessage(summary, at), ...messages.slice(cut)]);
              const notice = yield* store.compact(
                id,
                keep,
                { summary, tokensBefore, usage: answer.usage, timestamp: at },
                `Compacted the conversation to save tokens: about ${kTokens(tokensBefore)} → ${kTokens(after)}.`,
              );
              yield* events.entry(notice);
              return yield* store.context(id);
            }),
        };

  const setStatus = (next: BotStatus, extra: { tool?: string | undefined; error?: string | undefined; searching?: boolean | undefined } = {}) =>
    Effect.gen(function* () {
      if (status.status === next && status.tool === extra.tool && status.error === extra.error && status.searching === extra.searching) return;
      status = { status: next, ...extra, since: yield* now };
      yield* events.status(id);
    });

  const append = <K extends "assistant" | "system" | "notice">(kind: K, message: EntryBody[K]) =>
    Effect.tap(store.append(id, kind, message), (stored) => events.entry(stored));

  const userMessage = (row: InboxRow): Effect.Effect<TopUserMessage> =>
    Effect.gen(function* () {
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
      if (row.mode !== "steer" || delivered.has(row.requestId)) return;
      const message = yield* userMessage(row);
      if (delivered.has(row.requestId)) return;
      delivered.add(row.requestId);
      steering.push(message);
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
          return;
        case "system":
          yield* append("system", message);
          return;
      }
    });

  const refreshTools = () => {
    toolList = toolSource();
    tools = new Map(toolList.map((tool) => [tool.name, tool]));
  };
  refreshTools();

  const take = <A>(queue: A[]) => queue.splice(0);

  const loop = (signal: AbortSignal, prompts?: readonly TranscriptMessage[]) =>
    Effect.gen(function* () {
      looping = true;
      yield* runLoop(
        {
          models,
          model,
          thinkingLevel: options.thinkingLevel ?? "off",
          sessionId: cacheKey(id),
          compact,
          messages,
          tools: toolList,
          toolContext: (toolCallId) => ({ key: key(assistantSeq, toolCallId), bot: id }),
          signal,
          stopped: () => abortRequested,
          steering: () => take(steering),
          transformContext: attachments ? (context) => withImageData(context, attachments) : undefined,
          webSearch: options.webSearch ? { offer: searchOn } : undefined,
          hooks: {
            added: saveMessage,
            asking: setStatus("thinking"),
            toolStart: (call) => {
              runningTools++;
              return setStatus("tool", { tool: call.name });
            },
            toolRunning: (call, args) => store.toolStarted(id, assistantSeq, call.id, call.name, args),
            toolEnd: (result, ran) =>
              Effect.gen(function* () {
                const stored = yield* store.toolFinished(id, assistantSeq, result.toolCallId, result);
                if (ran) yield* store.setRestarts(id, 0);
                yield* events.entry(stored);
                if (--runningTools === 0) yield* setStatus("thinking");
              }),
            searching: (on) => (status.status === "thinking" ? setStatus("thinking", on ? { searching: true } : {}) : Effect.void),
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

  const updateSections = Effect.gen(function* () {
    if (!options.sections) return;
    const wanted = yield* options.sections;
    const current = getCurrentSystemMessage(messages)?.sections ?? {};
    const changed = Object.entries(wanted).filter(([name, value]) => (current[name] ?? null) !== value);
    systemUpdate = changed.length ? { role: "system", content: "", sections: Object.fromEntries(changed), timestamp: yield* now } : undefined;
  });
  yield* updateSections;

  const takePendingError = (): AssistantMessage | undefined => {
    const failed = pendingError;
    pendingError = undefined;
    return failed;
  };

  const run = (prompts: readonly TranscriptMessage[] | undefined, queued: readonly InboxRow[], prompted: readonly InboxRow[] = []) =>
    Effect.gen(function* () {
      refreshTools();
      searchOn = options.webSearch ? yield* options.webSearch : false;
      steering = [];
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
          if (abortRequested || delay === undefined || permanentFailure(failed.errorMessage)) {
            yield* append("assistant", failed);
            yield* setStatus("failed", { error: failed.errorMessage ?? "The model request failed" });
            break;
          }
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
        const last = messages.at(-1);
        if (abortRequested && !(last?.role === "assistant" && last.stopReason === "aborted")) {
          yield* append("notice", { text: "Stopped" });
        }
        return true;
      }).pipe(
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
      yield* store.setRunActive(id, false);
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
      const taken = yield* Effect.forEach(inbox, userMessage);
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
          if (!row.source || !(gatherMs > 0)) return start;
          return Effect.asVoid(
            FiberHandle.run(gather, Effect.sleep(Duration.millis(gatherMs)).pipe(Effect.andThen(Effect.forkIn(start, scope))), { onlyIfMissing: true }),
          );
        }
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
