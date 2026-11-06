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
import { getCurrentSystemMessage, type AssistantMessage, type Models, type SystemMessage, type ToolResultMessage } from "@earendil-works/pi-ai";
import type { BotStatus } from "@top/protocol";
import type { BotRow, InboxRow, StoredEntry, Store } from "./store.ts";
import { text, type ToolResult, type TopTool } from "./tools.ts";

/** A task may survive this many daemon restarts; the next one ends it. */
export const RESTART_LIMIT = 3;
/** Backoff before each retry of a failed model request (`TOP_RETRY_DELAYS_MS=100,100,100` shortens it for tests). */
const RETRY_DELAYS_MS = process.env.TOP_RETRY_DELAYS_MS?.split(",").map(Number) ?? [1_000, 4_000, 15_000];

export type RunnerStatus = { readonly status: BotStatus; readonly tool?: string; readonly error?: string; readonly since: number };

export type RunnerOptions = {
  readonly thinkingLevel?: ThinkingLevel;
  /** Named system prompt sections the bot should have. A change is saved just before the next message the bot takes. */
  readonly sections?: Readonly<Record<string, string>>;
};

export type RunnerEvents = {
  entry(entry: StoredEntry): void;
  inbox(bot: number): void;
  status(bot: number): void;
};

type ToolCallPart = { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };

const toolCallsOf = (message: AssistantMessage): ToolCallPart[] =>
  message.content.filter((part) => part.type === "toolCall") as unknown as ToolCallPart[];

function toolResultMessage(toolCallId: string, toolName: string, result: ToolResult, isError: boolean): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: (result.content ?? []) as ToolResultMessage["content"],
    details: result.details,
    isError,
    timestamp: Date.now(),
  } as ToolResultMessage;
}

export class BotRunner {
  readonly id: number;
  readonly name: string;
  readonly #store: Store;
  /** The bot's tools now: its own, plus those of the MCP servers it's been given that are connected. */
  readonly #toolSource: () => readonly TopTool[];
  #tools = new Map<string, TopTool>();
  readonly #events: RunnerEvents;
  readonly #agent: Agent;

  #busy = false;
  #idleWaiters: (() => void)[] = [];
  /** requestId of each queued message object handed to the Agent. */
  readonly #requestIds = new WeakMap<object, string>();
  /** requestIds handed to the Agent's queues in the current run. */
  readonly #delivered = new Set<string>();
  /** The saved assistant message whose tool calls are running. */
  #assistantSeq = 0;
  /** A failed model request, held back until we know whether a retry succeeds. */
  #pendingError: AssistantMessage | undefined;
  #abortRequested = false;
  #wakeRetry: (() => void) | undefined;
  #status: RunnerStatus = { status: "idle", since: Date.now() };
  /** Prompt sections that changed since the transcript last said; saved with the next message taken. */
  #systemUpdate: SystemMessage | undefined;

  /**
   * `tools` is asked again at the start of every run, so tools that come and go (an MCP server given
   * to the bot, or one that connected) reach the model from its next message. The Agent declares the
   * difference in a system message, which is saved like any other.
   */
  constructor(bot: BotRow, store: Store, models: Models, tools: () => readonly TopTool[], events: RunnerEvents, options: RunnerOptions = {}) {
    const thinkingLevel = options.thinkingLevel ?? "off";
    this.id = bot.id;
    this.name = bot.name;
    this.#store = store;
    this.#events = events;
    this.#toolSource = tools;
    // Split at the first slash only: model ids can contain one too (OpenRouter's "anthropic/claude-…").
    const slash = bot.model.indexOf("/");
    const model = models.getModel(bot.model.slice(0, slash), bot.model.slice(slash + 1));
    if (!model) throw new Error(`Bot ${bot.name}: unknown model ${bot.model}`);

    this.#agent = new Agent({
      // The stored transcript starts with the bot's system message, so the Agent adds none of its own.
      initialState: { model, thinkingLevel, tools: [], messages: store.context(bot.id).map((e) => e.message as AgentMessage) },
      streamFn: models.streamSimple.bind(models),
      identity: { attribution: null },
      beforeToolCall: async ({ toolCall, args }) => {
        // Stop means stop: no tool starts after the user asked to stop, whatever the model wants.
        if (this.#abortRequested) return { block: true, reason: "Not run: stopped by the user." };
        // Recorded before it runs: after a crash, a call with this record and no result may have taken effect.
        this.#store.toolStarted(this.id, this.#assistantSeq, toolCall.id, toolCall.name, args);
        return undefined;
      },
      // ...and no new model request starts after it either (tool results of the stopped turn are kept).
      finishTurn: async () => (this.#abortRequested ? { action: "end" } : undefined),
    });
    this.#agent.subscribe((event) => this.#onEvent(event));
    this.#refreshTools();

    const current = getCurrentSystemMessage(this.#agent.state.messages as never)?.sections ?? {};
    const changed = Object.entries(options.sections ?? {}).filter(([name, text]) => current[name] !== text);
    if (changed.length) this.#systemUpdate = { role: "system", content: "", sections: Object.fromEntries(changed), timestamp: Date.now() };
  }

  /** The bot's current system prompt, as the model will see it (with any pending update). */
  get systemPrompt(): SystemMessage | undefined {
    const messages = this.#agent.state.messages as never as SystemMessage[];
    return getCurrentSystemMessage(this.#systemUpdate ? [...messages, this.#systemUpdate] : messages);
  }

  get status(): RunnerStatus {
    return this.#status;
  }

  /** Running a task, or about to. */
  get busy(): boolean {
    return this.#busy;
  }

  waitForIdle(): Promise<void> {
    if (!this.#busy) return Promise.resolve();
    return new Promise((resolve) => this.#idleWaiters.push(resolve));
  }

  /** Start working: after `recover()`, and whenever a message arrives. */
  start() {
    void this.#drive();
  }

  /** A message was accepted into the inbox. */
  submitted(row: InboxRow) {
    if (!this.#busy) return this.start();
    // Mid-run: hand it to the Agent so it lands at the next turn (steer) or when the task would end
    // (follow-up). Between runs, the next run picks it up from the inbox.
    if (this.#agent.state.isStreaming) this.#deliver(row);
  }

  abort() {
    if (!this.#busy) return;
    this.#abortRequested = true;
    this.#wakeRetry?.();
    this.#agent.abort();
  }

  // ── recovery ─────────────────────────────────────────────────────────────────

  /**
   * Settle what the last process left unfinished. Call once at startup, before `start()`.
   * Returns a description of what was done, for the log.
   */
  async recover(): Promise<string | undefined> {
    const bot = this.#store.bot(this.id)!;
    if (!bot.runActive) return undefined;
    const restarts = bot.restarts + 1;
    this.#store.setRestarts(this.id, restarts);
    const giveUp = restarts > RESTART_LIMIT;

    const messages = this.#agent.state.messages;
    let assistantIndex = messages.length - 1;
    while (assistantIndex >= 0 && messages[assistantIndex]!.role === "toolResult") assistantIndex--;
    const assistant = messages[assistantIndex];
    const settled: string[] = [];
    if (assistant?.role === "assistant") {
      const assistantSeq = this.#store.lastAssistantSeq(this.id);
      const done = this.#store.toolResultsAfter(this.id, assistantSeq);
      for (const call of toolCallsOf(assistant as AssistantMessage)) {
        if (done.has(call.id)) continue;
        const outcome = await this.#settle(call, assistantSeq, giveUp, restarts);
        settled.push(`${call.name}: ${outcome}`);
      }
    }
    if (giveUp) {
      this.#append("notice", { text: `Stopped this task: the daemon restarted ${restarts} times while it ran.` });
      this.#store.setRunActive(this.id, false);
      this.#store.setRestarts(this.id, 0);
      this.#setStatus("failed", { error: `Stopped after ${restarts} restarts` });
    }
    return `restart ${restarts}${giveUp ? " (task ended)" : ""}${settled.length ? `; ${settled.join(", ")}` : ""}`;
  }

  async #settle(call: ToolCallPart, assistantSeq: number, giveUp: boolean, restarts: number): Promise<string> {
    const record = this.#store.toolCall(assistantSeq, call.id);
    const tool = this.#tools.get(call.name);
    const ctx = { key: this.#key(assistantSeq, call.id), bot: this.id };
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
      this.#setStatus("tool", { tool: call.name });
      try {
        result = await tool.run(args, ctx);
        isError = result.isError === true;
      } catch (error) {
        result = text(error instanceof Error ? error.message : String(error));
      }
    } else {
      const recovered = tool?.recover ? await tool.recover(args, ctx).catch(() => undefined) : undefined;
      if (recovered) {
        outcome = "recovered";
        result = recovered;
        isError = recovered.isError === true;
      } else if (recovered === false) {
        outcome = "not_run";
        result = text("Did not take effect: the daemon restarted while this tool ran, and the tool confirmed it did not complete. Call it again if it is still needed.");
      } else {
        outcome = "interrupted";
        result = text("Interrupted: the daemon restarted while this tool was running. It may or may not have taken effect. Check before calling it again.");
      }
    }
    const message = toolResultMessage(call.id, call.name, result, isError);
    const stored = this.#store.toolFinished(this.id, assistantSeq, call.id, message, outcome);
    this.#agent.state.messages.push(message);
    this.#events.entry(stored);
    return outcome;
  }

  // ── running ──────────────────────────────────────────────────────────────────

  async #drive() {
    if (this.#busy) return;
    this.#busy = true;
    try {
      for (;;) {
        const tail = this.#agent.state.messages.at(-1);
        const resumable = (tail?.role === "user" || tail?.role === "toolResult") && this.#store.bot(this.id)!.runActive;
        const inbox = this.#store.inbox(this.id);
        if (resumable) {
          if (!(await this.#run(() => this.#agent.continue(), inbox))) break;
          continue;
        }
        const [first, ...rest] = inbox;
        if (!first) break;
        const message = this.#userMessage(first);
        // A prompt change goes in just before the message, in the same run, so it's saved with it.
        const update = this.#systemUpdate;
        this.#systemUpdate = undefined;
        if (!(await this.#run(() => this.#agent.prompt(update ? [update, message] : message), rest))) break;
      }
    } finally {
      this.#busy = false;
      if (this.#status.status !== "failed") this.#setStatus("idle");
      for (const resolve of this.#idleWaiters.splice(0)) resolve();
    }
  }

  /** Take the bot's tools as they are now. Between runs only: a run keeps the tools it started with. */
  #refreshTools() {
    const tools = this.#toolSource();
    this.#tools = new Map(tools.map((tool) => [tool.name, tool]));
    this.#agent.state.tools = tools.map(
      (tool): AgentTool<any> => ({
        name: tool.name,
        label: tool.label,
        description: tool.description,
        parameters: tool.parameters,
        replay: tool.replay ?? "never",
        ...(tool.prepareArguments ? { prepareArguments: tool.prepareArguments } : {}),
        ...(tool.executionMode ? { executionMode: tool.executionMode } : {}),
        execute: (toolCallId, params, signal) => tool.run(params as Record<string, unknown>, { key: this.#key(this.#assistantSeq, toolCallId), bot: this.id, signal }),
      }),
    );
  }

  /** One run of the agent loop, with retries. False if something unexpected broke and driving should stop. */
  async #run(start: () => Promise<void>, queued: readonly InboxRow[]): Promise<boolean> {
    this.#refreshTools();
    this.#agent.clearAllQueues();
    this.#delivered.clear();
    for (const row of queued) this.#deliver(row);
    this.#abortRequested = false;
    this.#pendingError = undefined;
    this.#store.setRunActive(this.id, true);
    this.#setStatus("thinking");
    try {
      await start();
      for (let attempt = 0; ; attempt++) {
        const failed = this.#takePendingError();
        if (!failed) break;
        const delay = RETRY_DELAYS_MS[attempt];
        if (this.#abortRequested || delay === undefined) {
          this.#append("assistant", failed);
          this.#setStatus("failed", { error: failed.errorMessage ?? "The model request failed" });
          break;
        }
        // Drop the failed attempt and ask again after a backoff.
        const messages = this.#agent.state.messages;
        if (messages.at(-1) === failed) messages.pop();
        this.#setStatus("retrying", { error: failed.errorMessage });
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, delay);
          this.#wakeRetry = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        this.#wakeRetry = undefined;
        if (this.#abortRequested) {
          this.#append("assistant", { ...failed, stopReason: "aborted", errorMessage: "Stopped" });
          break;
        }
        for (const row of this.#store.inbox(this.id)) this.#deliver(row);
        this.#setStatus("thinking");
        await this.#agent.continue();
      }
      // A stop that landed between steps leaves no aborted answer behind; say so in the transcript.
      const last = this.#agent.state.messages.at(-1);
      if (this.#abortRequested && !(last?.role === "assistant" && (last as AssistantMessage).stopReason === "aborted")) {
        this.#append("notice", { text: "Stopped" });
      }
      return true;
    } catch (error) {
      console.error(`[${this.name}] run failed:`, error);
      this.#setStatus("failed", { error: error instanceof Error ? error.message : String(error) });
      return false;
    } finally {
      this.#store.setRunActive(this.id, false);
    }
  }

  /** Set by the event listener while the Agent runs, so read it through a call TypeScript can't narrow. */
  #takePendingError(): AssistantMessage | undefined {
    const failed = this.#pendingError;
    this.#pendingError = undefined;
    return failed;
  }

  #onEvent(event: AgentEvent) {
    switch (event.type) {
      case "message_start":
        if (event.message.role === "assistant") this.#setStatus("thinking");
        return;
      case "message_end":
        return this.#saveMessage(event.message);
      case "tool_execution_start":
        return this.#setStatus("tool", { tool: event.toolName });
      case "tool_execution_end": {
        const message = toolResultMessage(event.toolCallId, event.toolName, event.result as ToolResult, event.isError);
        const stored = this.#store.toolFinished(this.id, this.#assistantSeq, event.toolCallId, message);
        // A tool that really ran to completion is progress; settled-after-crash results are not.
        if (event.durationMs !== undefined) this.#store.setRestarts(this.id, 0);
        this.#events.entry(stored);
        const running = this.#agent.state.pendingToolCalls.size;
        if (!running) this.#setStatus("thinking");
        return;
      }
    }
  }

  #saveMessage(message: AgentMessage) {
    switch (message.role) {
      case "user": {
        const requestId = this.#requestIds.get(message);
        const stored = requestId ? this.#store.place(this.id, requestId, message) : this.#store.append(this.id, "user", message);
        this.#events.entry(stored);
        if (requestId) this.#events.inbox(this.id);
        return;
      }
      case "assistant": {
        const assistant = message as AssistantMessage;
        if (assistant.stopReason === "error") {
          this.#pendingError = assistant;
          return;
        }
        const stored = this.#append("assistant", assistant);
        this.#assistantSeq = stored.seq;
        if (!toolCallsOf(assistant).length && assistant.stopReason !== "aborted") this.#store.setRestarts(this.id, 0);
        return;
      }
      case "toolResult":
        return; // saved at tool_execution_end, the moment the tool returned
      case "system":
        this.#append("system", message);
        return;
    }
  }

  #append(kind: "assistant" | "system" | "notice", message: unknown): StoredEntry {
    const stored = this.#store.append(this.id, kind, message);
    this.#events.entry(stored);
    return stored;
  }

  #deliver(row: InboxRow) {
    if (this.#delivered.has(row.requestId)) return;
    this.#delivered.add(row.requestId);
    const message = this.#userMessage(row);
    if (row.mode === "steer") this.#agent.steer(message);
    else this.#agent.followUp(message);
  }

  #userMessage(row: InboxRow): AgentMessage {
    const message: AgentMessage = { role: "user", content: row.text, timestamp: row.at };
    this.#requestIds.set(message, row.requestId);
    return message;
  }

  #key(assistantSeq: number, toolCallId: string): string {
    return `${this.id}:${assistantSeq}:${toolCallId}`;
  }

  #setStatus(status: BotStatus, extra: { tool?: string; error?: string } = {}) {
    const current = this.#status;
    if (current.status === status && current.tool === extra.tool && current.error === extra.error) return;
    this.#status = { status, ...extra, since: Date.now() };
    this.#events.status(this.id);
  }
}
