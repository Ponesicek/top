/**
 * The agent loop: ask the model, run the tools it calls, ask again, until it answers without calling
 * one. Top's own, on Effect; pi-ai still talks to the models.
 *
 * - Every step goes through a hook, and the loop waits for it: whatever the hook saves is saved before
 *   the next step starts.
 * - Stop (`stopped()`): no tool starts and no model request goes out after it. The signal tells the
 *   request and the running tools to wind down, and what they come to is kept.
 * - Interrupting the loop (the daemon stopping, the bot deleted) ends it where it is: the signal tells
 *   the request and the tools to stop, and nothing more is saved.
 *
 * It follows pi-agent-core's loop (1.5.0) step for step where Top used it: messages that arrive while
 * the bot works go in at the next turn (steering) or when it would end (follow-ups), all at once; tool
 * calls run in parallel unless one of them must run alone; tools that came or went since the transcript
 * last said so are declared to the model in a system message before its next request.
 *
 * A transcript that has grown past `compact.atTokens` is compacted before the next request (see
 * compaction.ts): the model summarises it, and the summary stands in for it from then on.
 */
import {
  type Api,
  type AssistantMessage,
  getCurrentTools,
  getToolStateChanges,
  type Model,
  type Models,
  normalizeContext,
  type SystemMessage,
  type ToolCall,
  type ToolResultMessage,
  type ToolStateChanges,
  toToolDeclaration,
} from "@earendil-works/pi-ai";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { compactionCut, SUMMARY_REQUEST } from "./compaction.ts";
import { type TranscriptMessage, textOf } from "./messages.ts";
import { checkArguments, type ToolArguments, type ToolContext, type ToolResult, type TopTool, text } from "./tools.ts";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type LoopHooks = {
  /** A message the loop added to the transcript: one it took from the user or Top, a system message, the model's answer. */
  readonly added: (message: TranscriptMessage) => Effect.Effect<void>;
  /** A model request is about to go out. */
  readonly asking: Effect.Effect<void>;
  /** The model's call is being looked at (it may still not run). */
  readonly toolStart: (call: ToolCall) => Effect.Effect<void>;
  /** The call checked out and runs next: after a crash, a call recorded here may have taken effect. */
  readonly toolRunning: (call: ToolCall, args: ToolArguments) => Effect.Effect<void>;
  /** The call's result; `ran` when the tool really ran (not refused, not stopped before it started). */
  readonly toolEnd: (result: ToolResultMessage, ran: boolean) => Effect.Effect<void>;
};

export type LoopOptions = {
  readonly models: Models;
  readonly model: Model<Api>;
  readonly thinkingLevel: ThinkingLevel;
  /**
   * The same for every request of one transcript (a bot's). Providers route on it to the machine that
   * holds the transcript's prompt cache (OpenAI's `prompt_cache_key`); without it, a request often
   * lands where nothing is cached and the whole transcript is read again at full price.
   */
  readonly sessionId: string;
  /** The transcript. The loop adds to it as it goes. */
  readonly messages: TranscriptMessage[];
  /** The tools for this run. */
  readonly tools: readonly TopTool[];
  /** What a tool call gets besides the signal. */
  readonly toolContext: (toolCallId: string) => Omit<ToolContext, "signal">;
  /** Fires on Stop, or when the loop is interrupted. */
  readonly signal: AbortSignal;
  readonly stopped: () => boolean;
  /** Messages for the next turn, taken. */
  readonly steering: () => TranscriptMessage[];
  /** Messages for when the bot would finish, taken. */
  readonly followUps: () => TranscriptMessage[];
  /** The transcript as the model gets it (images read in, for example). */
  readonly transformContext?: ((messages: readonly TranscriptMessage[]) => Effect.Effect<readonly TranscriptMessage[]>) | undefined;
  readonly hooks: LoopHooks;
  /** Compact the transcript when it's longer than this; without it, never. */
  readonly compact?: Compact | undefined;
};

export type Compact = {
  /** In tokens, as `contextTokens` counts them. */
  readonly atTokens: number;
  /**
   * Save the summary in place of all but the transcript's last `keep` messages, and answer the
   * transcript as it is now. `answer` is the model's, whose text is the summary.
   */
  readonly save: (summary: string, keep: number, answer: AssistantMessage, tokensBefore: number) => Effect.Effect<readonly TranscriptMessage[]>;
};

/** A tool result as it goes in the transcript. */
export const toolResultMessage = (toolCallId: string, toolName: string, result: ToolResult, isError: boolean, timestamp: number): ToolResultMessage => ({
  role: "toolResult",
  toolCallId,
  toolName,
  content: result.content,
  ...(result.details === undefined ? {} : { details: result.details }),
  isError,
  timestamp,
});

export const toolCallsOf = (message: AssistantMessage): ToolCall[] => message.content.filter((part): part is ToolCall => part.type === "toolCall");

const NO_CHANGES: ToolStateChanges = { toolsAdded: [], toolsRemoved: [] };

/** A system message with its tool fields replaced by `changes`; empty lists leave the field out. */
function withToolChanges(message: SystemMessage, changes: ToolStateChanges): SystemMessage {
  const { toolsAdded: _added, toolsRemoved: _removed, ...rest } = message;
  return {
    ...rest,
    ...(changes.toolsAdded.length ? { toolsAdded: changes.toolsAdded } : {}),
    ...(changes.toolsRemoved.length ? { toolsRemoved: changes.toolsRemoved } : {}),
  };
}

/**
 * `pending` as it goes in, saying which tools came or went since the transcript last said so: on the
 * pending system message if there is one (a prompt change), else on a new one before the first other
 * message. Other messages stay the same objects.
 */
function declareToolChanges(
  transcript: readonly TranscriptMessage[],
  tools: readonly TopTool[],
  pending: readonly TranscriptMessage[],
  now: number,
): TranscriptMessage[] {
  const systemIndex = pending.findLastIndex((message) => message.role === "system");
  const found = pending[systemIndex];
  const system = found?.role === "system" ? found : undefined;
  const baseline = system ? pending.map((message, index) => (index === systemIndex ? withToolChanges(system, NO_CHANGES) : message)) : [...pending];
  const changes = getToolStateChanges(
    getCurrentTools([...transcript, ...baseline]),
    tools.map((tool) => toToolDeclaration(tool)),
  );
  const unchanged = !changes.toolsAdded.length && !changes.toolsRemoved.length;
  if (system) {
    if (unchanged && !system.toolsAdded?.length && !system.toolsRemoved?.length) return [...pending];
    return baseline.map((message, index) => (index === systemIndex ? withToolChanges(system, changes) : message));
  }
  if (unchanged) return [...pending];
  const update = withToolChanges({ role: "system", content: "", timestamp: now }, changes);
  const first = pending.findIndex((message) => message.role !== "system");
  const at = first === -1 ? pending.length : first;
  return [...pending.slice(0, at), update, ...pending.slice(at)];
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

type Prepared = { readonly call: ToolCall; readonly tool: TopTool; readonly args: ToolArguments } | { readonly call: ToolCall; readonly result: ToolResult };

/**
 * Run the loop on the transcript in `options.messages`: with `prompts`, they go in first; without,
 * it continues from where the transcript ends (a user message or tool results).
 */
export const runLoop = (options: LoopOptions, prompts?: readonly TranscriptMessage[]): Effect.Effect<void> =>
  Effect.gen(function* () {
    const { messages, tools, hooks, signal, stopped } = options;
    const reasoning = options.thinkingLevel === "off" ? undefined : options.thinkingLevel;

    const add = (incoming: readonly TranscriptMessage[]) =>
      Effect.gen(function* () {
        for (const next of declareToolChanges(messages, tools, incoming, yield* Clock.currentTimeMillis)) {
          messages.push(next);
          yield* hooks.added(next);
        }
      });

    /**
     * The model's answer to `transcript`. Every request is made the same way, so they all start alike
     * and the provider's prompt cache covers what they share.
     */
    const request = (transcript: readonly TranscriptMessage[]) =>
      Effect.gen(function* () {
        const context = options.transformContext ? yield* options.transformContext(transcript) : transcript;
        const llm = normalizeContext({
          messages: context.filter((m) => m.role === "system" || m.role === "user" || m.role === "assistant" || m.role === "toolResult"),
        });
        const response = options.models.streamSimple(options.model, llm, {
          ...(reasoning ? { reasoning } : {}),
          transport: "auto",
          sessionId: options.sessionId,
          identity: { attribution: null },
          signal,
        });
        const answer = yield* Effect.promise(() => response.result());
        answer.thinkingLevel = options.thinkingLevel;
        return answer;
      });

    /** A compaction failed in this run: don't ask for another. */
    let compactionFailed = false;
    /** Compact the transcript if it's grown too long (see compaction.ts). A failure leaves it as it was. */
    const compactIfLong = Effect.gen(function* () {
      const compact = options.compact;
      if (!compact || compactionFailed) return;
      const due = compactionCut(messages, compact.atTokens);
      if (!due) return;
      const { cut, tokens: tokensBefore } = due;
      const answer = yield* request([...messages.slice(0, cut), { role: "user", content: SUMMARY_REQUEST, timestamp: yield* Clock.currentTimeMillis }]);
      const summary = textOf(answer.content.filter((part) => part.type === "text")).trim();
      if (answer.stopReason !== "stop" || toolCallsOf(answer).length || !summary) {
        compactionFailed = true;
        if (!signal.aborted) yield* Effect.logWarning(`compaction failed (${answer.stopReason}): ${answer.errorMessage ?? "no summary"}`);
        return;
      }
      const next = yield* compact.save(summary, messages.length - cut, answer, tokensBefore);
      messages.splice(0, messages.length, ...next);
    }).pipe(
      Effect.catchDefect((defect) =>
        Effect.gen(function* () {
          compactionFailed = true;
          yield* Effect.logWarning("compaction failed", defect);
        }),
      ),
      Effect.withSpan("Loop.compact"),
    );

    /** The model's answer. A request that couldn't be made is an answer that failed, so it's retried like one. */
    const ask = Effect.gen(function* () {
      yield* hooks.asking;
      yield* compactIfLong;
      return yield* request(messages);
    }).pipe(
      Effect.catchDefect((defect) =>
        Effect.map(
          Clock.currentTimeMillis,
          (timestamp): AssistantMessage => ({
            role: "assistant",
            content: [{ type: "text", text: "" }],
            api: options.model.api,
            provider: options.model.provider,
            model: options.model.id,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: signal.aborted ? "aborted" : "error",
            errorMessage: message(defect),
            timestamp,
          }),
        ),
      ),
      Effect.withSpan("Loop.ask"),
    );

    const end = (call: ToolCall, result: ToolResult, isError: boolean, ran: boolean) =>
      Effect.gen(function* () {
        const done = toolResultMessage(call.id, call.name, result, isError, yield* Clock.currentTimeMillis);
        yield* hooks.toolEnd(done, ran);
        return { done, terminate: result.terminate === true };
      });

    /** Check a call and record it, or say why it doesn't run. */
    const prepare = (call: ToolCall) =>
      Effect.gen(function* (): Effect.fn.Return<Prepared> {
        yield* hooks.toolStart(call);
        const tool = tools.find((t) => t.name === call.name);
        if (!tool) return { call, result: text(`Tool ${call.name} not found`) };
        const checked = yield* Effect.result(Effect.try(() => checkArguments(tool, call, call.arguments)));
        if (checked._tag === "Failure") return { call, result: text(message(checked.failure.cause)) };
        const args = checked.success;
        // Stop means stop: no tool starts after the user asked to stop, whatever the model wants.
        if (stopped()) return { call, result: text("Not run: stopped by the user.") };
        yield* hooks.toolRunning(call, args);
        if (signal.aborted) return { call, result: text("Operation aborted") };
        return { call, tool, args };
      });

    const execute = (prepared: Prepared) =>
      Effect.gen(function* () {
        if (!("tool" in prepared)) return yield* end(prepared.call, prepared.result, true, false);
        const { call, tool, args } = prepared;
        const ran = yield* tool.run(args, { ...options.toolContext(call.id), signal }).pipe(
          Effect.map((result) => ({ result, isError: result.isError === true })),
          Effect.catch((error) => Effect.succeed({ result: text(error.message), isError: true })),
          Effect.catchDefect((defect) => Effect.succeed({ result: text(message(defect)), isError: true })),
          Effect.withSpan("Loop.tool", { attributes: { tool: call.name } }),
        );
        return yield* end(call, ran.result, ran.isError, true);
      });

    /** The calls of one answer, and whether the model should be asked again after them. */
    const runTools = (answer: AssistantMessage, calls: readonly ToolCall[]) =>
      Effect.gen(function* () {
        const results: { done: ToolResultMessage; terminate: boolean }[] = [];
        if (answer.stopReason === "length") {
          // Cut off by the output limit: every call may have truncated arguments, so none runs.
          for (const call of calls) {
            yield* hooks.toolStart(call);
            const result = text(
              `Tool call "${call.name}" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.`,
            );
            const ended = yield* end(call, result, true, false);
            messages.push(ended.done);
            results.push(ended);
          }
          return true;
        }
        if (calls.some((call) => tools.find((t) => t.name === call.name)?.executionMode === "sequential")) {
          for (const call of calls) {
            const ended = yield* execute(yield* prepare(call));
            messages.push(ended.done);
            results.push(ended);
            if (signal.aborted) break;
          }
        } else {
          // Each call is checked and recorded in turn, then they run together; results go in in call order.
          const queued: (Prepared | { done: ToolResultMessage; terminate: boolean })[] = [];
          for (const call of calls) {
            const prepared = yield* prepare(call);
            queued.push("tool" in prepared ? prepared : yield* execute(prepared));
            if (signal.aborted) break;
          }
          const ended = yield* Effect.forEach(
            queued,
            (entry) =>
              "done" in entry ? Effect.succeed(entry) : signal.aborted ? execute({ call: entry.call, result: text("Operation aborted") }) : execute(entry),
            { concurrency: "unbounded" },
          );
          for (const entry of ended) {
            messages.push(entry.done);
            results.push(entry);
          }
        }
        return !(results.length > 0 && results.every((r) => r.terminate));
      });

    if (prompts) yield* add(prompts);
    let pending = options.steering();
    for (;;) {
      let more = true;
      while (more || pending.length) {
        yield* add(pending);
        pending = [];
        if (stopped()) return;
        const answer = yield* ask;
        messages.push(answer);
        yield* hooks.added(answer);
        if (answer.stopReason === "error" || answer.stopReason === "aborted") return;
        const calls = toolCallsOf(answer);
        more = calls.length ? yield* runTools(answer, calls) : false;
        // ...and no new model request starts after a Stop either (tool results of the stopped turn are kept).
        if (stopped()) return;
        pending = options.steering();
      }
      pending = options.followUps();
      if (!pending.length) return;
    }
  });
