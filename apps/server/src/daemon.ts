/**
 * The daemon's parts wired together: storage, one runner per bot, and the sidebar summaries.
 * The WebSocket layer (serve.ts) and the load driver both go through `submit()` and the listeners here.
 */
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { createInitialSystemMessage, type Models, toToolDeclaration } from "@earendil-works/pi-ai";
import { type BotSummary, MAX_BOT_DESCRIPTION, MAX_BOT_NAME, type WhenBusy } from "@top/protocol";
import { collarTools } from "./collar/index.ts";
import { FilesFolder, type Listing } from "./files.ts";
import { Jobs } from "./jobs.ts";
import type { McpManager } from "./mcp.ts";
import { BotRunner, type RunnerOptions } from "./runner.ts";
import type { BotRow, InboxRow, Store, StoredEntry } from "./store.ts";
import type { TopTool } from "./tools.ts";
import { WakeClock } from "./wakes.ts";
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
    const line = prose[i]!.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+|#{1,6}\s+|>\s?)+/, "")
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
  /** Each bot's files folder (see files.ts). Without it, bots have none. */
  files?: (bot: BotRow) => string;
  /** How long a tool call may run before it moves to the background (see jobs.ts). */
  foregroundMs?: number;
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
  readonly #filesListeners = new Set<(bot: number, folder: FilesFolder) => void>();
  readonly #folders = new Map<number, FilesFolder>();
  /** Tool calls that outran the time limit and run on in the background (see jobs.ts). */
  readonly jobs: Jobs;
  /** Wake-ups the bots set for themselves (see wakes.ts). */
  readonly wakes: WakeClock;
  /** Each bot's tools as they are now, without the time limit (see `toolsOf`). */
  readonly #toolSources = new Map<number, () => readonly TopTool[]>();
  /** Top's own tools, which every bot has (see collar/index.ts). */
  readonly #collar = collarTools(this);

  /**
   * `tools` and `sections` may differ per bot (each real bot works in its own folder). Without
   * `newBot`, bots can't be made from the app.
   */
  constructor(store: Store, models: Models, tools: Tools, options: DaemonOptions = {}) {
    this.store = store;
    this.#models = models;
    this.#tools = tools;
    this.#options = options;
    this.jobs = new Jobs(store, { deliver: (row) => this.#queued(row), changed: (bot) => this.#touch(bot) }, options.foregroundMs);
    this.wakes = new WakeClock(store, (row) => this.#queued(row));
    for (const bot of store.bots()) this.#add(bot);
  }

  #add(bot: BotRow): BotRunner {
    const { thinking, sections } = this.#options;
    // A deleted bot may still be finishing a step; nothing it does after that is announced.
    const live = () => this.runners.get(bot.id) === runner;
    // The bot's own tools and Collar are fixed; MCP tools are asked for again at each run. Any of
    // them that runs too long moves to the background.
    const own = [...(typeof this.#tools === "function" ? this.#tools(bot) : this.#tools), ...this.#collar];
    const mcp = this.#options.mcp;
    const plain = mcp ? () => [...own, ...mcp.toolsFor(bot.id)] : () => own;
    this.#toolSources.set(bot.id, plain);
    const wrapped = own.map((tool) => this.jobs.wrap(tool));
    const tools = mcp ? () => [...wrapped, ...mcp.toolsFor(bot.id).map((tool) => this.jobs.wrap(tool))] : () => wrapped;
    const runner: BotRunner = new BotRunner(
      bot,
      this.store,
      this.#models,
      tools,
      {
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
      },
      { thinkingLevel: thinking ?? "off", ...(sections ? { sections: sections(bot) } : {}) },
    );
    this.runners.set(bot.id, runner);
    this.#summaries.set(bot.id, this.#summarize(bot.id));
    if (this.#options.files) {
      const folder = new FilesFolder(bot.id, this.#options.files(bot), this.store, (_listing: Listing, entry) => {
        if (!live()) return;
        if (entry) {
          for (const listener of this.#entryListeners) listener(entry);
          this.#touch(bot.id);
        }
        for (const listener of this.#filesListeners) listener(bot.id, folder);
      });
      this.#folders.set(bot.id, folder);
      void folder.start();
    }
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
    this.#toolSources.delete(id);
    this.#summaries.delete(id);
    clearTimeout(this.#dirty.get(id));
    this.#dirty.delete(id);
    this.#folders.get(id)?.close();
    this.#folders.delete(id);
    this.store.markDeleted(id);
    this.wakes.changed();
    for (const listener of this.#removedListeners) listener(id);
    this.#options.mcp?.botRemoved(id);
    runner.abort();
    this.jobs.stopAll(id);
    void runner
      .waitForIdle()
      .then(() => this.store.purgeBot(id))
      .catch((error) => console.error(`[top] deleting ${runner.name}:`, error));
  }

  /** Settle whatever the last process left unfinished, then start every bot, then the wake-up clock. */
  async start() {
    const lost = this.jobs.recover();
    if (lost) console.log(`[top] ${lost} background job${lost === 1 ? " was" : "s were"} cut off by the restart`);
    for (const runner of this.runners.values()) {
      const report = await runner.recover();
      if (report) console.log(`[top] ${runner.name}: ${report}`);
    }
    for (const runner of this.runners.values()) runner.start();
    this.wakes.start();
  }

  /** The user's Stop: the bot's task ends, and so do its background jobs. Its wake-ups stay. */
  stop(bot: number) {
    this.runner(bot).abort();
    this.jobs.stopAll(bot);
  }

  /** Stop the clocks (the daemon is shutting down). */
  close() {
    this.wakes.close();
    for (const timer of this.#dirty.values()) clearTimeout(timer);
    this.#dirty.clear();
    this.closeFiles();
  }

  /** Something about a bot changed that its summary shows (wake-ups, jobs). */
  changed(bot: number) {
    if (this.runners.has(bot)) this.#touch(bot);
  }

  /** A bot's tools as they are now (its own, Collar's, its MCP servers'), as written: no time limit. */
  toolsOf(bot: number): readonly TopTool[] {
    return this.#toolSources.get(bot)?.() ?? [];
  }

  /** The MCP servers set up in the app, when this daemon has them. */
  get mcp(): McpManager | undefined {
    return this.#options.mcp;
  }

  /** Whether bots have files folders here. */
  get hasFiles(): boolean {
    return this.#options.files !== undefined;
  }

  /** A bot's files folder, when this daemon gives bots one. */
  files(bot: number): FilesFolder | undefined {
    return this.#folders.get(bot);
  }

  /** Stop watching the files folders (the daemon is shutting down). */
  closeFiles() {
    for (const folder of this.#folders.values()) folder.close();
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
    this.#queued(this.store.inboxRow(requestId) as InboxRow);
    return { duplicate: false };
  }

  /** A message is in a bot's inbox (from the user, a wake-up or a job): announce it and hand it to the bot. */
  #queued(row: InboxRow) {
    const runner = this.runners.get(row.bot);
    if (!runner) return;
    for (const listener of this.#inboxListeners) listener(row.bot);
    this.#touch(row.bot);
    runner.submitted(row);
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
  /** A bot's files changed (or were listed for the first time). */
  onFiles(listener: (bot: number, folder: FilesFolder) => void) {
    this.#filesListeners.add(listener);
    return () => this.#filesListeners.delete(listener);
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

  /** What the bot is waiting on: jobs in the background, its next wake-up. */
  #waiting(bot: number): { background?: number; wakeAt?: number } {
    const background = this.jobs.count(bot);
    const wakeAt = this.store.wakes(bot)[0]?.dueAt;
    return { ...(background ? { background } : {}), ...(wakeAt !== undefined ? { wakeAt } : {}) };
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
      ...this.#waiting(bot),
      lastSeq: this.store.lastSeq(bot),
    };
  }
}
