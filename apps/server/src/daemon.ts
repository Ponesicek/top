/**
 * The daemon's parts wired together: storage, one runner per bot, and the sidebar summaries.
 * The WebSocket layer (serve.ts) and the load driver both go through `submit()` and the listeners here.
 */
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { createInitialSystemMessage, toToolDeclaration, type Models } from "@earendil-works/pi-ai";
import type { BotSummary, WhenBusy } from "@top/protocol";
import { BotRunner, type RunnerOptions } from "./runner.ts";
import type { BotRow, InboxRow, StoredEntry, Store } from "./store.ts";
import type { TopTool } from "./tools.ts";
import { textOf } from "./wire.ts";

const SUMMARY_DELAY_MS = 100;

export class BusyError extends Error {
  override name = "ConversationBusy";
}

function lastLine(text: string): string {
  const lines = text.trimEnd().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.replace(/[`*#|>-]/g, "").trim();
    if (line) return line.slice(0, 120);
  }
  return "";
}

/** Create the bots on first start. Each bot's transcript begins with its system message. */
export function ensureBots(
  store: Store,
  names: readonly string[],
  model: string,
  tools: readonly TopTool[],
  instructionsFor: (name: string) => string = (name) => `You are ${name}, one of the user's bots.`,
) {
  if (store.bots().length > 0) return;
  for (const name of names) {
    const instructions = instructionsFor(name);
    const id = store.createBot(name, instructions, model);
    store.append(id, "system", createInitialSystemMessage(instructions, tools.map(toToolDeclaration)));
  }
}

export class Daemon {
  readonly store: Store;
  readonly runners = new Map<number, BotRunner>();
  readonly #summaries = new Map<number, BotSummary>();
  readonly #dirty = new Map<number, ReturnType<typeof setTimeout>>();
  readonly #entryListeners = new Set<(entry: StoredEntry) => void>();
  readonly #inboxListeners = new Set<(bot: number) => void>();
  readonly #botListeners = new Set<(summary: BotSummary) => void>();

  /** `tools` and `sections` may differ per bot (each real bot works in its own folder). */
  constructor(
    store: Store,
    models: Models,
    tools: readonly TopTool[] | ((bot: BotRow) => readonly TopTool[]),
    options: { thinking?: ThinkingLevel; sections?: (bot: BotRow) => RunnerOptions["sections"] } = {},
  ) {
    this.store = store;
    for (const bot of store.bots()) {
      const runner = new BotRunner(bot, store, models, typeof tools === "function" ? tools(bot) : tools, {
        entry: (entry) => {
          for (const listener of this.#entryListeners) listener(entry);
          if (entry.kind !== "system") this.#touch(bot.id);
        },
        inbox: (id) => {
          for (const listener of this.#inboxListeners) listener(id);
          this.#touch(id);
        },
        status: (id) => this.#touch(id),
      }, { thinkingLevel: options.thinking ?? "off", ...(options.sections ? { sections: options.sections(bot) } : {}) });
      this.runners.set(bot.id, runner);
      this.#summaries.set(bot.id, this.#summarize(bot.id));
    }
  }

  /** Settle whatever the last process left unfinished, then start every bot. */
  async start() {
    for (const runner of this.runners.values()) {
      const report = await runner.recover();
      if (report) console.log(`[top] ${runner.name}: ${report}`);
    }
    for (const runner of this.runners.values()) runner.start();
  }

  get bots(): BotSummary[] {
    return [...this.#summaries.values()];
  }

  runner(bot: number): BotRunner {
    const runner = this.runners.get(bot);
    if (!runner) throw new Error(`Unknown bot ${bot}`);
    return runner;
  }

  /** Accept a message. Durable when this returns; a repeated `requestId` changes nothing. */
  submit(bot: number, requestId: string, text: string, whenBusy: WhenBusy, clientId: string | null): { duplicate: boolean } {
    const runner = this.runner(bot);
    if (whenBusy === "reject" && (runner.busy || this.store.inbox(bot).length > 0)) throw new BusyError(`${runner.name} is busy`);
    const result = this.store.submit(bot, requestId, text, whenBusy === "steer" ? "steer" : "followUp", clientId);
    if (result === "duplicate") return { duplicate: true };
    for (const listener of this.#inboxListeners) listener(bot);
    this.#touch(bot);
    runner.submitted(this.store.inboxRow(requestId) as InboxRow);
    return { duplicate: false };
  }

  onEntry(listener: (entry: StoredEntry) => void) {
    this.#entryListeners.add(listener);
    return () => this.#entryListeners.delete(listener);
  }
  onInbox(listener: (bot: number) => void) {
    this.#inboxListeners.add(listener);
    return () => this.#inboxListeners.delete(listener);
  }
  onBot(listener: (summary: BotSummary) => void) {
    this.#botListeners.add(listener);
    return () => this.#botListeners.delete(listener);
  }

  /** Recompute one bot's summary soon, and announce it only if it changed. */
  #touch(bot: number) {
    if (this.#dirty.has(bot)) return;
    this.#dirty.set(
      bot,
      setTimeout(() => {
        this.#dirty.delete(bot);
        const next = this.#summarize(bot);
        const previous = this.#summaries.get(bot);
        if (previous && JSON.stringify(previous) === JSON.stringify(next)) return;
        this.#summaries.set(bot, next);
        for (const listener of this.#botListeners) listener(next);
      }, SUMMARY_DELAY_MS),
    );
  }

  #summarize(bot: number): BotSummary {
    const row = this.store.bot(bot)!;
    const runner = this.runners.get(bot);
    const status = runner?.status ?? { status: "idle" as const, since: Date.now() };
    const answer = this.store.lastAnswer(bot) as { content?: string | { type: string; text?: string }[] } | undefined;
    return {
      id: bot,
      name: row.name,
      status: status.status,
      ...(status.tool ? { tool: status.tool } : {}),
      ...(status.error ? { error: status.error } : {}),
      since: status.since,
      preview: lastLine(textOf(answer?.content)),
      queued: this.store.inbox(bot).length,
      lastSeq: this.store.lastSeq(bot),
    };
  }
}
