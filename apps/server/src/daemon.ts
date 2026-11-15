/**
 * The daemon's parts wired together: storage, one runner per bot, the sidebar summaries, background
 * jobs and wake-ups. The WebSocket layer (serve.ts) and the load driver go through this service and
 * listen to the event bus (events.ts).
 */
import { createInitialSystemMessage, type Models, toToolDeclaration } from "@earendil-works/pi-ai";
import {
  type Attachment,
  AttachmentError,
  BotError,
  type BotSummary,
  BusyError,
  MAX_ATTACHMENTS,
  MAX_BOT_DESCRIPTION,
  MAX_BOT_NAME,
  UnknownBotError,
  type WhenBusy,
} from "@top/protocol";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberMap from "effect/FiberMap";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import { Attachments } from "./attachments.ts";
import { collarTools } from "./collar/index.ts";
import { Events } from "./events.ts";
import { type FilesFolder, makeFilesFolder } from "./files.ts";
import { type Jobs, makeJobs } from "./jobs.ts";
import type { ThinkingLevel } from "./loop.ts";
import { Mcp } from "./mcp.ts";
import { type BotRunner, makeRunner } from "./runner.ts";
import { seedHistory } from "./seed.ts";
import { type BotRow, type InboxRow, Store, type StoredEntry } from "./store.ts";
import type { TopTool } from "./tools.ts";
import { makeWakeClock, type WakeClock } from "./wakes.ts";
import { textOf } from "./wire.ts";

const SUMMARY_DELAY_MS = 100;

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

/** What the daemon's bots are made of: real ones on a model with the computer's tools, or fake ones. */
export class BotKit extends Context.Service<
  BotKit,
  {
    readonly models: Models;
    /** The bots' own tools; per bot when they differ (each real bot works in its own folder, made first). */
    readonly tools: readonly TopTool[] | ((bot: BotRow) => Effect.Effect<readonly TopTool[]>);
    readonly thinking: ThinkingLevel;
    /** Named system prompt sections each bot should have (see runner.ts). */
    readonly sections?: ((bot: BotRow) => Effect.Effect<Readonly<Record<string, string>>>) | undefined;
    /** How bots are made, and the first ones (made once). Without it, bots can't be made from the app. */
    readonly newBot?: NewBot | undefined;
    readonly firstBots?: readonly string[] | undefined;
    /** Give the first bot a history this long (`--seed`). */
    readonly seed?: number | undefined;
    /** Each bot's files folder (see files.ts). Without it, bots have none. */
    readonly files?: ((bot: BotRow) => string) | undefined;
    /** How long a tool call may run before it moves to the background (see jobs.ts). */
    readonly foregroundMs: number;
    /** How long Top's own messages to an idle bot wait for others before starting a task (see runner.ts). */
    readonly gatherMs?: number | undefined;
    /** Backoff before each retry of a failed model request. */
    readonly retryDelaysMs?: readonly number[] | undefined;
  }
>()("top/BotKit") {}

/** Add a bot to the store. Its transcript begins with its system message. */
const addBot = (name: string, description: string, newBot: NewBot) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const instructions = newBot.instructions(name, description);
    return yield* store.transaction(
      Effect.gen(function* () {
        const id = yield* store.createBot(name, instructions, newBot.model, description);
        const system = createInitialSystemMessage(instructions, newBot.declare.map(toToolDeclaration));
        if (system) yield* store.append(id, "system", system);
        return id;
      }),
    );
  });

/** Create the first bots, once: a user who deletes them all doesn't get them back on the next start. */
export const ensureBots = (names: readonly string[], newBot: NewBot) =>
  Effect.gen(function* () {
    const store = yield* Store;
    if (yield* store.flag("seeded")) return;
    if ((yield* store.bots).length === 0) for (const name of names) yield* addBot(name, "", newBot);
    yield* store.setFlag("seeded");
  });

type LiveBot = {
  readonly runner: BotRunner;
  /** Everything the bot runs (its task, its gather timer, its files watcher) lives here. */
  readonly scope: Scope.Closeable;
  folder: FilesFolder | undefined;
  summary: BotSummary;
};

export class Daemon extends Context.Service<
  Daemon,
  {
    /** Every bot's summary, for the sidebar. */
    readonly bots: () => BotSummary[];
    readonly has: (bot: number) => boolean;
    readonly runner: (bot: number) => Effect.Effect<BotRunner, UnknownBotError>;
    readonly runners: () => BotRunner[];
    /** Make a bot and announce it. Fails with a `BotError` the user can read when the name is empty or taken. */
    readonly createBot: (name: string, description: string) => Effect.Effect<number, BotError>;
    /**
     * Delete a bot and its transcript. It leaves the roster at once; whatever it was doing is stopped,
     * and its rows are removed once it has. Files it made in its folder stay.
     */
    readonly deleteBot: (id: number) => Effect.Effect<void, UnknownBotError>;
    /**
     * Accept a message, with the attachments it names (uploaded already). Durable once this has run; a
     * repeated `requestId` changes nothing.
     */
    readonly submit: (
      bot: number,
      requestId: string,
      text: string,
      whenBusy: WhenBusy,
      clientId: string | null,
      attachmentIds?: readonly string[],
    ) => Effect.Effect<{ duplicate: boolean }, UnknownBotError | BusyError | AttachmentError>;
    /** The user's Stop: the bot's task ends, and so do its background jobs. Its wake-ups stay. */
    readonly stop: (bot: number) => Effect.Effect<void, UnknownBotError>;
    /** Settle whatever the last process left unfinished, then start every bot, then the wake-up clock. */
    readonly start: Effect.Effect<void>;
    /** Something about a bot changed that its summary shows (wake-ups, jobs). */
    readonly changed: (bot: number) => Effect.Effect<void>;
    /** A bot's tools as they are now (its own, Collar's, its MCP servers'), as written: no time limit. */
    readonly toolsOf: (bot: number) => readonly TopTool[];
    /** Whether bots have files folders here. */
    readonly hasFiles: boolean;
    /** A bot's files folder, once it has been listed. */
    readonly files: (bot: number) => FilesFolder | undefined;
    readonly jobs: Jobs;
    readonly wakes: WakeClock;
  }
>()("top/Daemon") {}

const make = Effect.gen(function* () {
  const store = yield* Store;
  const events = yield* Events;
  const kit = yield* BotKit;
  const fs = yield* FileSystem.FileSystem;
  const mcp = Option.getOrUndefined(yield* Effect.serviceOption(Mcp));
  const attachments = Option.getOrUndefined(yield* Effect.serviceOption(Attachments));
  const scope = yield* Effect.scope;
  const bots = new Map<number, LiveBot>();
  /** Each bot's tools as they are now, without the time limit (see `toolsOf`). */
  const toolSources = new Map<number, () => readonly TopTool[]>();
  /** Summaries waiting to be recomputed (see `touch`). */
  const dirty = yield* FiberMap.make<number>();

  if (kit.newBot && kit.firstBots) yield* ensureBots(kit.firstBots, kit.newBot);
  // One model for every bot for now; switching `--model` moves the existing bots over.
  if (kit.newBot) for (const bot of yield* store.bots) if (bot.model !== kit.newBot.model) yield* store.setModel(bot.id, kit.newBot.model);
  const seeded = (yield* store.bots)[0];
  if (kit.seed && seeded) yield* seedHistory(seeded.id, kit.seed);

  /** What the bot is waiting on: jobs in the background, its next wake-up. */
  const waiting = (bot: number): Effect.Effect<{ background?: number; wakeAt?: number }> =>
    Effect.gen(function* () {
      const background = jobs.count(bot);
      const wakeAt = (yield* store.wakes(bot))[0]?.dueAt;
      return { ...(background ? { background } : {}), ...(wakeAt !== undefined ? { wakeAt } : {}) };
    });

  const summarize = (bot: number, runner: BotRunner | undefined): Effect.Effect<BotSummary> =>
    Effect.gen(function* () {
      const row = (yield* store.bot(bot))!;
      const status = runner?.status() ?? { status: "idle" as const, since: yield* Clock.currentTimeMillis };
      const answer = yield* store.lastAnswer(bot);
      return {
        id: bot,
        name: row.name,
        description: row.description,
        status: status.status,
        ...(status.tool ? { tool: status.tool } : {}),
        ...(status.error ? { error: status.error } : {}),
        since: status.since,
        preview: lastLine(textOf(answer?.content)),
        queued: (yield* store.inbox(bot)).length,
        ...(yield* waiting(bot)),
        lastSeq: yield* store.lastSeq(bot),
      } satisfies BotSummary;
    });

  /** Recompute one bot's summary soon, and announce it only if it changed. */
  const touch = (bot: number): Effect.Effect<void> =>
    Effect.asVoid(
      FiberMap.run(
        dirty,
        bot,
        Effect.gen(function* () {
          yield* Effect.sleep(Duration.millis(SUMMARY_DELAY_MS));
          const live = bots.get(bot);
          if (!live) return;
          const next = yield* summarize(bot, live.runner);
          if (JSON.stringify(live.summary) === JSON.stringify(next)) return;
          live.summary = next;
          yield* events.publish({ _tag: "Bot", summary: next });
        }),
        { onlyIfMissing: true },
      ),
    );

  /** A message is in a bot's inbox (from the user, a wake-up or a job): announce it and hand it to the bot. */
  const queued = (row: InboxRow): Effect.Effect<void> =>
    Effect.gen(function* () {
      const live = bots.get(row.bot);
      if (!live) return;
      yield* events.publish({ _tag: "Inbox", bot: row.bot });
      yield* touch(row.bot);
      yield* live.runner.submitted(row);
    });

  const changed = (bot: number): Effect.Effect<void> => (bots.has(bot) ? touch(bot) : Effect.void);
  const jobs: Jobs = yield* makeJobs({ deliver: queued, changed }, kit.foregroundMs);
  const wakes = yield* makeWakeClock(queued);
  const toolsOf = (bot: number) => toolSources.get(bot)?.() ?? [];
  /** Top's own tools, which every bot has (see collar/index.ts). */
  const collar = collarTools({ store, jobs, wakes, changed, toolsOf });

  const add = (bot: BotRow): Effect.Effect<LiveBot> =>
    Effect.gen(function* () {
      const botScope = yield* Scope.fork(scope);
      // A deleted bot may still be finishing a step; nothing it does after that is announced.
      const isLive = () => bots.get(bot.id)?.scope === botScope;
      const announce = (entry: StoredEntry) =>
        Effect.suspend(() => {
          if (!isLive()) return Effect.void;
          return Effect.andThen(events.publish({ _tag: "Entry", entry }), entry.kind !== "system" ? touch(bot.id) : Effect.void);
        });
      // The bot's own tools and Collar are fixed; MCP tools are asked for again at each run. Any of
      // them that runs too long moves to the background.
      const own = [...(typeof kit.tools === "function" ? yield* kit.tools(bot) : kit.tools), ...collar];
      const plain = mcp ? () => [...own, ...mcp.toolsFor(bot.id)] : () => own;
      toolSources.set(bot.id, plain);
      const wrapped = own.map(jobs.wrap);
      const tools = mcp ? () => [...wrapped, ...mcp.toolsFor(bot.id).map(jobs.wrap)] : () => wrapped;
      const runner = yield* makeRunner(
        bot,
        kit.models,
        tools,
        {
          entry: announce,
          inbox: (id) => (isLive() ? Effect.andThen(events.publish({ _tag: "Inbox", bot: id }), touch(id)) : Effect.void),
          status: (id) => (isLive() ? touch(id) : Effect.void),
        },
        {
          thinkingLevel: kit.thinking,
          sections: kit.sections ? yield* kit.sections(bot) : undefined,
          gatherMs: kit.gatherMs,
          attachments,
          retryDelaysMs: kit.retryDelaysMs,
        },
      ).pipe(Scope.provide(botScope));
      const live: LiveBot = { runner, scope: botScope, folder: undefined, summary: yield* summarize(bot.id, runner) };
      bots.set(bot.id, live);
      if (kit.files) {
        const path = kit.files(bot);
        // Listed in the background: a big folder mustn't hold up the daemon's start.
        yield* makeFilesFolder(bot.id, path, (listing, entry) =>
          Effect.gen(function* () {
            if (!isLive()) return;
            if (entry) yield* announce(entry);
            yield* events.publish({ _tag: "Files", bot: bot.id, folder: path, listing });
          }),
        ).pipe(
          Effect.tap((folder) =>
            Effect.sync(() => {
              live.folder = folder;
            }),
          ),
          Scope.provide(botScope),
          Effect.forkIn(botScope),
        );
      }
      return live;
    }).pipe(Effect.provideService(Store, store), Effect.provideService(FileSystem.FileSystem, fs));

  for (const bot of yield* store.bots) yield* add(bot);

  const runnerOf = (bot: number) =>
    Effect.suspend(() => {
      const live = bots.get(bot);
      return live ? Effect.succeed(live.runner) : Effect.fail(new UnknownBotError({ bot }));
    });

  return Daemon.of({
    bots: () => [...bots.values()].map((live) => live.summary),
    has: (bot) => bots.has(bot),
    runner: runnerOf,
    runners: () => [...bots.values()].map((live) => live.runner),
    createBot: Effect.fn("Daemon.createBot")(function* (rawName, rawDescription) {
      const newBot = kit.newBot;
      if (!newBot) return yield* new BotError({ message: "This daemon can't make bots." });
      const name = rawName.trim().replace(/\s+/g, " ");
      const description = rawDescription.trim();
      if (!name) return yield* new BotError({ message: "Give the bot a name." });
      if (name.length > MAX_BOT_NAME) return yield* new BotError({ message: `Keep the name under ${MAX_BOT_NAME + 1} characters.` });
      if (description.length > MAX_BOT_DESCRIPTION)
        return yield* new BotError({ message: `Keep the description under ${MAX_BOT_DESCRIPTION + 1} characters.` });
      // Case-insensitive: a real bot's folder is named after it, and Windows and macOS folders ignore case.
      const taken = [...bots.values()].some((live) => live.runner.name.toLowerCase() === name.toLowerCase());
      if (taken) return yield* new BotError({ message: `There's already a bot named ${name}.` });
      const id = yield* addBot(name, description, newBot).pipe(Effect.provideService(Store, store));
      const live = yield* add((yield* store.bot(id))!);
      yield* events.publish({ _tag: "Bot", summary: live.summary });
      return id;
    }),
    deleteBot: Effect.fn("Daemon.deleteBot")(function* (id) {
      const live = bots.get(id);
      if (!live) return yield* new UnknownBotError({ bot: id });
      bots.delete(id);
      toolSources.delete(id);
      yield* FiberMap.remove(dirty, id);
      yield* store.markDeleted(id);
      yield* wakes.changed;
      yield* events.publish({ _tag: "BotRemoved", bot: id });
      if (mcp) yield* mcp.botRemoved(id);
      const { runner } = live;
      yield* runner.close;
      yield* runner.abort;
      yield* jobs.stopAll(id);
      // Its rows go once it has stopped: a step it was finishing can still be written meanwhile.
      yield* Effect.forkIn(
        Effect.gen(function* () {
          yield* runner.waitForIdle;
          yield* Scope.close(live.scope, Exit.void);
          if (attachments) yield* attachments.removeBot(id);
          yield* store.purgeBot(id);
        }).pipe(Effect.catchCause((cause) => Effect.logError(`deleting ${runner.name}`, cause))),
        scope,
      );
    }),
    submit: Effect.fn("Daemon.submit")(function* (bot, requestId, text, whenBusy, clientId, attachmentIds = []) {
      const runner = yield* runnerOf(bot);
      if (whenBusy === "reject" && (runner.busy() || (yield* store.inbox(bot)).length > 0)) return yield* new BusyError({ message: `${runner.name} is busy` });
      if (attachmentIds.length && !attachments) return yield* new AttachmentError({ message: "This daemon doesn't take attachments." });
      if (attachmentIds.length > MAX_ATTACHMENTS) return yield* new AttachmentError({ message: `A message can have up to ${MAX_ATTACHMENTS} attachments.` });
      if (!text.trim() && !attachmentIds.length) return yield* new AttachmentError({ message: "The message is empty." });
      const found: Attachment[] = attachments ? yield* attachments.lookup(bot, attachmentIds) : [];
      const result = yield* store.submit(bot, requestId, text, whenBusy === "steer" ? "steer" : "followUp", clientId, found);
      if (result === "duplicate") return { duplicate: true };
      yield* queued((yield* store.inboxRow(requestId))!);
      return { duplicate: false };
    }),
    stop: Effect.fn("Daemon.stop")(function* (bot) {
      const runner = yield* runnerOf(bot);
      yield* runner.abort;
      yield* jobs.stopAll(bot);
    }),
    start: Effect.gen(function* () {
      const lost = yield* jobs.recover;
      if (lost) yield* Effect.log(`${lost} background job${lost === 1 ? " was" : "s were"} cut off by the restart`);
      for (const live of bots.values()) {
        const report = yield* live.runner.recover;
        if (report) yield* Effect.log(`${live.runner.name}: ${report}`);
      }
      for (const live of bots.values()) yield* live.runner.start;
      yield* wakes.start;
    }).pipe(Effect.withSpan("Daemon.start")),
    changed,
    toolsOf,
    hasFiles: kit.files !== undefined,
    files: (bot) => bots.get(bot)?.folder,
    jobs,
    wakes,
  });
});

/** The daemon, running its bots until the layer closes. */
export const layer: Layer.Layer<Daemon, never, Store | Events | BotKit | FileSystem.FileSystem> = Layer.effect(Daemon, make);
