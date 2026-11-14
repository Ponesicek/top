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
 */
import {
  type AssistantMessage,
  getCurrentTools,
  getToolStateChanges,
  type Message,
  type Model,
  type Models,
  normalizeContext,
  type SystemMessage,
  type ToolCall,
  type ToolResultMessage,
  toToolDeclaration,
  validateToolArguments,
} from "@earendil-works/pi-ai";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { type ToolContext, type ToolResult, type TopTool, text } from "./tools.ts";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type LoopHooks = {
  /** A message the loop added to the transcript: one it took from the user or Top, a system message, the model's answer. */
  readonly added: (message: Message) => Effect.Effect<void>;
  /** A model request is about to go out. */
  readonly asking: Effect.Effect<void>;
  /** The model's call is being looked at (it may still not run). */
  readonly toolStart: (call: ToolCall) => Effect.Effect<void>;
  /** The call checked out and runs next: after a crash, a call recorded here may have taken effect. */
  readonly toolRunning: (call: ToolCall, args: Record<string, unknown>) => Effect.Effect<void>;
  /** The call's result; `ran` when the tool really ran (not refused, not stopped before it started). */
  readonly toolEnd: (result: ToolResultMessage, ran: boolean) => Effect.Effect<void>;
};

export type LoopOptions = {
  readonly models: Models;
  // biome-ignore lint/suspicious/noExplicitAny: a model of any API
  readonly model: Model<any>;
  readonly thinkingLevel: ThinkingLevel;
  /** The transcript. The loop adds to it as it goes. */
  readonly messages: Message[];
  /** The tools for this run. */
  readonly tools: readonly TopTool[];
  /** What a tool call gets besides the signal. */
  readonly toolContext: (toolCallId: string) => Omit<ToolContext, "signal">;
  /** Fires on Stop, or when the loop is interrupted. */
  readonly signal: AbortSignal;
  readonly stopped: () => boolean;
  /** Messages for the next turn, taken. */
  readonly steering: () => Message[];
  /** Messages for when the bot would finish, taken. */
  readonly followUps: () => Message[];
  /** The transcript as the model gets it (images read in, for example). */
  readonly transformContext?: ((messages: Message[]) => Effect.Effect<Message[]>) | undefined;
  readonly hooks: LoopHooks;
};

/** A tool result as it goes in the transcript. */
export const toolResultMessage = (toolCallId: string, toolName: string, result: ToolResult, isError: boolean, timestamp: number): ToolResultMessage =>
  ({
    role: "toolResult",
    toolCallId,
    toolName,
    content: (result.content ?? []) as ToolResultMessage["content"],
    details: result.details,
    isError,
    timestamp,
  }) as ToolResultMessage;

export const toolCallsOf = (message: AssistantMessage): ToolCall[] => message.content.filter((part): part is ToolCall => part.type === "toolCall");

const NO_CHANGES = { toolsAdded: [], toolsRemoved: [] };

/** A system message with its tool fields replaced by `changes`; empty lists leave the field out. */
function withToolChanges(message: SystemMessage, changes: { toolsAdded: readonly unknown[]; toolsRemoved: readonly unknown[] }): SystemMessage {
  const { toolsAdded: _added, toolsRemoved: _removed, ...rest } = message;
  return {
    ...rest,
    ...(changes.toolsAdded.length ? { toolsAdded: changes.toolsAdded } : {}),
    ...(changes.toolsRemoved.length ? { toolsRemoved: changes.toolsRemoved } : {}),
  } as SystemMessage;
}

/**
 * `pending` as it goes in, saying which tools came or went since the transcript last said so: on the
 * pending system message if there is one (a prompt change), else on a new one before the first other
 * message. Other messages stay the same objects.
 */
function declareToolChanges(transcript: readonly Message[], tools: readonly TopTool[], pending: readonly Message[], now: number): Message[] {
  const systemIndex = pending.findLastIndex((message) => message.role === "system");
  const system = pending[systemIndex] as SystemMessage | undefined;
  const baseline = system ? pending.map((message, index) => (index === systemIndex ? withToolChanges(system, NO_CHANGES) : message)) : [...pending];
  const changes = getToolStateChanges(
    getCurrentTools([...transcript, ...baseline]),
    tools.map((tool) => toToolDeclaration(tool as never)),
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

type Prepared =
  | { readonly call: ToolCall; readonly tool: TopTool; readonly args: Record<string, unknown> }
  | { readonly call: ToolCall; readonly result: ToolResult };

/**
 * Run the loop on the transcript in `options.messages`: with `prompts`, they go in first; without,
 * it continues from where the transcript ends (a user message or tool results).
 */
export const runLoop = (options: LoopOptions, prompts?: readonly Message[]): Effect.Effect<void> =>
  Effect.gen(function* () {
    const { messages, tools, hooks, signal, stopped } = options;
    const reasoning = options.thinkingLevel === "off" ? undefined : options.thinkingLevel;

    const add = (incoming: readonly Message[]) =>
      Effect.gen(function* () {
        for (const next of declareToolChanges(messages, tools, incoming, yield* Clock.currentTimeMillis)) {
          messages.push(next);
          yield* hooks.added(next);
        }
      });

    /** The model's answer. A request that couldn't be made is an answer that failed, so it's retried like one. */
    const ask = Effect.gen(function* () {
      yield* hooks.asking;
      const context = options.transformContext ? yield* options.transformContext(messages) : messages;
      const llm = normalizeContext({
        messages: context.filter((m) => m.role === "system" || m.role === "user" || m.role === "assistant" || m.role === "toolResult"),
      });
      const response = options.models.streamSimple(options.model, llm, {
        ...(reasoning ? { reasoning } : {}),
        transport: "auto",
        identity: { attribution: null },
        signal,
      });
      const answer = yield* Effect.promise(() => response.result());
      return Object.assign(answer, { thinkingLevel: options.thinkingLevel }) as AssistantMessage;
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
        const checked = yield* Effect.result(
          Effect.try(() => {
            const prepared = tool.prepareArguments ? { ...call, arguments: tool.prepareArguments(call.arguments) as ToolCall["arguments"] } : call;
            return validateToolArguments(tool as never, prepared) as Record<string, unknown>;
          }),
        );
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
