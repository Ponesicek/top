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
import { type TopAssistantMessage, type TranscriptMessage, textOf } from "./messages.ts";
import { checkArguments, type ToolArguments, type ToolContext, type ToolResult, type TopTool, text } from "./tools.ts";
import { captureWebSearch, searchRefusal, withWebSearch } from "./websearch.ts";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type LoopHooks = {
  readonly added: (message: TranscriptMessage) => Effect.Effect<void>;
  readonly asking: Effect.Effect<void>;
  readonly toolStart: (call: ToolCall) => Effect.Effect<void>;
  readonly toolRunning: (call: ToolCall, args: ToolArguments) => Effect.Effect<void>;
  readonly toolEnd: (result: ToolResultMessage, ran: boolean) => Effect.Effect<void>;
  readonly searching?: ((on: boolean) => Effect.Effect<void>) | undefined;
  /** A line under the bot's turn about what its runtime did (Claude's compaction, say), never sent to the model. */
  readonly notice?: ((text: string) => Effect.Effect<void>) | undefined;
};

export type LoopOptions = {
  readonly models: Models;
  readonly model: Model<Api>;
  readonly thinkingLevel: ThinkingLevel;
  readonly sessionId: string;
  readonly messages: TranscriptMessage[];
  readonly tools: readonly TopTool[];
  readonly toolContext: (toolCallId: string) => Omit<ToolContext, "signal">;
  readonly signal: AbortSignal;
  readonly stopped: () => boolean;
  readonly steering: () => TranscriptMessage[];
  readonly transformContext?: ((messages: readonly TranscriptMessage[]) => Effect.Effect<readonly TranscriptMessage[]>) | undefined;
  readonly webSearch?: { readonly offer: boolean } | undefined;
  readonly hooks: LoopHooks;
  readonly compact?: Compact | undefined;
};

export type Compact = {
  readonly atTokens: number;
  readonly save: (summary: string, keep: number, answer: AssistantMessage, tokensBefore: number) => Effect.Effect<readonly TranscriptMessage[]>;
};

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

function withToolChanges(message: SystemMessage, changes: ToolStateChanges): SystemMessage {
  const { toolsAdded: _added, toolsRemoved: _removed, ...rest } = message;
  return {
    ...rest,
    ...(changes.toolsAdded.length ? { toolsAdded: changes.toolsAdded } : {}),
    ...(changes.toolsRemoved.length ? { toolsRemoved: changes.toolsRemoved } : {}),
  };
}

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

export type ToolStepOptions = Pick<LoopOptions, "tools" | "hooks" | "signal" | "stopped" | "toolContext">;

/** How one tool call runs, the same for every runtime: announced, checked, recorded right before it runs, then its result saved. */
export const toolSteps = (options: ToolStepOptions) => {
  const { tools, hooks, signal, stopped } = options;
  const end = (call: ToolCall, result: ToolResult, isError: boolean, ran: boolean) =>
    Effect.gen(function* () {
      const done = toolResultMessage(call.id, call.name, result, isError, yield* Clock.currentTimeMillis);
      yield* hooks.toolEnd(done, ran);
      return { done, terminate: result.terminate === true };
    });

  const prepare = (call: ToolCall) =>
    Effect.gen(function* (): Effect.fn.Return<Prepared> {
      yield* hooks.toolStart(call);
      const tool = tools.find((t) => t.name === call.name);
      if (!tool) return { call, result: text(`Tool ${call.name} not found`) };
      const checked = yield* Effect.result(Effect.try(() => checkArguments(tool, call, call.arguments)));
      if (checked._tag === "Failure") return { call, result: text(message(checked.failure.cause)) };
      const args = checked.success;
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

  return { end, prepare, execute };
};

/** Runs one call through all its steps. */
export const runToolCall = (options: ToolStepOptions, call: ToolCall) => {
  const { prepare, execute } = toolSteps(options);
  return Effect.flatMap(prepare(call), execute);
};

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

    const request = (transcript: readonly TranscriptMessage[]) =>
      Effect.gen(function* () {
        const context = options.transformContext ? yield* options.transformContext(transcript) : transcript;
        const llm = normalizeContext({
          messages: context.filter((m) => m.role === "system" || m.role === "user" || m.role === "assistant" || m.role === "toolResult"),
        });
        const search = options.webSearch;
        const services = yield* Effect.context<never>();
        const capture = search?.offer
          ? captureWebSearch((on) => {
              if (hooks.searching) Effect.runForkWith(services)(hooks.searching(on));
            })
          : undefined;
        const response = options.models.streamSimple(options.model, llm, {
          ...(reasoning ? { reasoning } : {}),
          transport: "auto",
          sessionId: options.sessionId,
          identity: { attribution: null },
          signal,
          ...(search ? { onPayload: (payload: unknown) => withWebSearch(payload, context, search.offer) } : {}),
          ...(capture ? { onProviderStreamEvent: capture.event } : {}),
        });
        const answer: TopAssistantMessage = yield* Effect.promise(() => response.result());
        answer.thinkingLevel = options.thinkingLevel;
        const record = capture?.record();
        if (record) answer.webSearch = record;
        const refusal = search?.offer && answer.stopReason === "error" ? searchRefusal(answer.errorMessage) : undefined;
        if (refusal) answer.errorMessage = refusal;
        return answer;
      });

    let compactionFailed = false;
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

    const { end, prepare, execute } = toolSteps(options);

    const runTools = (answer: AssistantMessage, calls: readonly ToolCall[]) =>
      Effect.gen(function* () {
        const results: { done: ToolResultMessage; terminate: boolean }[] = [];
        if (answer.stopReason === "length") {
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
      if (stopped()) return;
      pending = options.steering();
    }
  });
