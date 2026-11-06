/**
 * The daemon's parts wired together: storage, one runner per bot, and the sidebar summaries.
 * The WebSocket layer (serve.ts) and the load driver both go through `submit()` and the listeners here.
 */
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { createInitialSystemMessage, toToolDeclaration, type Models } from "@earendil-works/pi-ai";
import { MAX_BOT_DESCRIPTION, MAX_BOT_NAME, type BotSummary, type WhenBusy } from "@top/protocol";
import { BotRunner, type RunnerOptions } from "./runner.ts";
import type { BotRow, InboxRow, StoredEntry, Store } from "./store.ts";
import type { McpManager } from "./mcp.ts";
import type { TopTool } from "./tools.ts";
import { textOf } from "./wire.ts";

const SUMMARY_DELAY_MS = 100;

export class BusyError extends Error {
  override name = "ConversationBusy";
}

/**
 * The answer's last line of prose, for the sidebar: code fences and table rows are skipped, and only
 * Markdown syntax is removed (list/heading/quote markers, emphasis, backticks), so text like
 * "follow-up" or "kill -9" survives intact.
 */
export function lastLine(text: string): string {
  const prose: string[] = [];
  let fenced = false;
  for (const raw of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(raw)) {
      fenced = !fenced;
      continue;
    }
    if (fenced || /^\s*\|/.test(raw)) continue;
    prose.push(raw);
  }
  for (let i = prose.length - 1; i >= 0; i--) {
    const line = prose[i]!
      .replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+|#{1,6}\s+|>\s?)+/, "")
      .replace(/(\*\*|__|`)/g, "")
      .trim();
    if (line) return line.slice(0, 120);
  }
  return "";
}

/** How new bots are made: the same for the first ones and for those made from the app. */
export type NewBot = {
  /** `provider/model-id`. */
  readonly model: string;
  /** The instructions that open the bot's first system message. */
  readonly instructions: (name: string, description: string) => string;
  /** Tools declared in that message. Real bots declare theirs on their first request instead. */
  readonly declare: readonly TopTool[];
};

export const defaultInstructions = (name: string, description: string) =>
  [`You are ${name}, one of the user's bots.`, ...(description ? [purpose(description)] : [])].join("\n");

/** The line of a bot's instructions that carries the description it was made with. */
export const purpose = (description: string) => `What the user made you for: ${description}`;

/** A bot was refused (empty or taken name, too long): the message is meant for the user. */
export class BotError extends Error {
  override name = "BotError";
}

/** Add a bot to the store. Its transcript begins with its system message. */
function addBot(store: Store, name: string, description: string, newBot: NewBot): number {
  const instructions = newBot.instructions(name, description);
  return store.transaction(() => {
    const id = store.createBot(name, instructions, newBot.model, description);
    store.append(id, "system", createInitialSystemMessage(instructions, newBot.declare.map(toToolDeclaration)));
    return id;
  });
}

/** Create the first bots, once: a user who deletes them all doesn't get them back on the next start. */
export function ensureBots(store: Store, names: readonly string[], newBot: NewBot) {
  if (store.flag("seeded")) return;
  if (store.bots().length === 0) for (const name of names) addBot(store, name, "", newBot);
  store.setFlag("seeded");
}

type Tools = readonly TopTool[] | ((bot: BotRow) => readonly TopTool[]);
type DaemonOptions = {
  thinking?: ThinkingLevel;
  sections?: (bot: BotRow) => RunnerOptions["sections"];
  newBot?: NewBot;
  /** MCP servers set up in the app; a bot gets the tools of those it has been given. */
  mcp?: McpManager;
};

export class Daemon {
  readonly store: Store;
  readonly runners = new Map<number, BotRunner>();
  readonly #models: Models;
  readonly #tools: Tools;
  readonly #options: DaemonOptions;
  readonly #summaries = new Map<number, BotSummary>();
  readonly #dirty = new Map<number, ReturnType<typeof setTimeout>>();
  readonly #entryListeners = new Set<(entry: StoredEntry) => void>();
  readonly #inboxListeners = new Set<(bot: number) => void>();
  readonly #botListeners = new Set<(summary: BotSummary) => void>();
  readonly #removedListeners = new Set<(bot: number) => void>();

  /**
   * `tools` and `sections` may differ per bot (each real bot works in its own folder). Without
   * `newBot`, bots can't be made from the app.
   */
  constructor(store: Store, models: Models, tools: Tools, options: DaemonOptions = {}) {
    this.store = store;
    this.#models = models;
    this.#tools = tools;
    this.#options = options;
    for (const bot of store.bots()) this.#add(bot);
  }

  #add(bot: BotRow): BotRunner {
    const { thinking, sections } = this.#options;
    // A deleted bot may still be finishing a step; nothing it does after that is announced.
    const live = () => this.runners.get(bot.id) === runner;
    // The bot's own tools are fixed; MCP tools are asked for again at each run.
    const own = typeof this.#tools === "function" ? this.#tools(bot) : this.#tools;
    const mcp = this.#options.mcp;
    const tools = mcp ? () => [...own, ...mcp.toolsFor(bot.id)] : () => own;
    const runner: BotRunner = new BotRunner(bot, this.store, this.#models, tools, {
      entry: (entry) => {
        if (!live()) return;
        for (const listener of this.#entryListeners) listener(entry);
        if (entry.kind !== "system") this.#touch(bot.id);
      },
      inbox: (id) => {
        if (!live()) return;
        for (const listener of this.#inboxListeners) listener(id);
        this.#touch(id);
      },
      status: (id) => live() && this.#touch(id),
    }, { thinkingLevel: thinking ?? "off", ...(sections ? { sections: sections(bot) } : {}) });
    this.runners.set(bot.id, runner);
    this.#summaries.set(bot.id, this.#summarize(bot.id));
    return runner;
  }

  /** Make a bot and announce it. Throws a `BotError` the user can read when the name is empty or taken. */
  createBot(name: string, description: string): number {
    if (!this.#options.newBot) throw new BotError("This daemon can't make bots.");
    name = name.trim().replace(/\s+/g, " ");
    description = description.trim();
    if (!name) throw new BotError("Give the bot a name.");
    if (name.length > MAX_BOT_NAME) throw new BotError(`Keep the name under ${MAX_BOT_NAME + 1} characters.`);
    if (description.length > MAX_BOT_DESCRIPTION) throw new BotError(`Keep the description under ${MAX_BOT_DESCRIPTION + 1} characters.`);
    // Case-insensitive: a real bot's folder is named after it, and Windows and macOS folders ignore case.
    const taken = [...this.runners.values()].some((runner) => runner.name.toLowerCase() === name.toLowerCase());
    if (taken) throw new BotError(`There's already a bot named ${name}.`);
    const id = addBot(this.store, name, description, this.#options.newBot);
    this.#add(this.store.bot(id)!);
    const summary = this.#summaries.get(id)!;
    for (const listener of this.#botListeners) listener(summary);
    return id;
  }

  /**
   * Delete a bot and its transcript. It leaves the roster at once; whatever it was doing is stopped,
   * and its rows are removed once it has. Files it made in its folder stay.
   */
  deleteBot(id: number) {
    const runner = this.runner(id);
    this.runners.delete(id);
    this.#summaries.delete(id);
    clearTimeout(this.#dirty.get(id));
    this.#dirty.delete(id);
    this.store.markDeleted(id);
    for (const listener of this.#removedListeners) listener(id);
    this.#options.mcp?.botRemoved(id);
    runner.abort();
    void runner
      .waitForIdle()
      .then(() => this.store.purgeBot(id))
      .catch((error) => console.error(`[top] deleting ${runner.name}:`, error));
  }

  /** Settle whatever the last process left unfinished, then start every bot. */
  async start() {
    for (const runner of this.runners.values()) {
      const report = await runner.recover();
      if (report) console.log(`[top] ${runner.name}: ${report}`);
    }
    for (const runner of this.runners.values()) runner.start();
  }

  /** The MCP servers set up in the app, when this daemon has them. */
  get mcp(): McpManager | undefined {
    return this.#options.mcp;
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
  onBotRemoved(listener: (bot: number) => void) {
    this.#removedListeners.add(listener);
    return () => this.#removedListeners.delete(listener);
  }

  /** Recompute one bot's summary soon, and announce it only if it changed. */
  #touch(bot: number) {
    if (this.#dirty.has(bot)) return;
    this.#dirty.set(
      bot,
      setTimeout(() => {
        this.#dirty.delete(bot);
        if (!this.runners.has(bot)) return;
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
      description: row.description,
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
