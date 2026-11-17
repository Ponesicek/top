import { createInitialSystemMessage, type Models, toToolDeclaration } from "@earendil-works/pi-ai";
import {
  type Attachment,
  AttachmentError,
  BotError,
  type BotSummary,
  BusyError,
  MAX_ATTACHMENTS,
  MAX_BOT_AVATAR,
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
import { makePermissions, type Permissions } from "./permissions.ts";
import { type BotRunner, makeRunner } from "./runner.ts";
import { seedHistory } from "./seed.ts";
import { makeSkills, type Skills, type SkillsConfig } from "./skills.ts";
import { type BotRow, type InboxRow, PLANNED_RESTART, Store, type StoredEntry } from "./store.ts";
import type { TopTool } from "./tools.ts";
import { makeWakeClock, type WakeClock } from "./wakes.ts";
import { WEB_SEARCH_SECTION } from "./websearch.ts";
import { textOf } from "./wire.ts";

const SUMMARY_DELAY_MS = 100;

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

export type NewBot = {
  readonly model: string;
  readonly instructions: (name: string, description: string) => string;
  readonly declare: readonly TopTool[];
};

export const defaultInstructions = (name: string, description: string) =>
  [`You are ${name}, one of the user's bots.`, ...(description ? [purpose(description)] : [])].join("\n");

export const purpose = (description: string) => `What the user made you for: ${description}`;

export class BotKit extends Context.Service<
  BotKit,
  {
    readonly models: Models;
    readonly tools: readonly TopTool[] | ((bot: BotRow) => Effect.Effect<readonly TopTool[]>);
    readonly thinking: ThinkingLevel;
    readonly sections?: ((bot: BotRow) => Effect.Effect<Readonly<Record<string, string>>>) | undefined;
    readonly newBot?: NewBot | undefined;
    readonly firstBots?: readonly string[] | undefined;
    readonly seed?: number | undefined;
    readonly files?: ((bot: BotRow) => string) | undefined;
    readonly skills?: SkillsConfig | undefined;
    readonly foregroundMs: number;
    readonly gatherMs?: number | undefined;
    readonly retryDelaysMs?: readonly number[] | undefined;
    readonly repeatGapMs?: number | undefined;
    readonly compactAtTokens?: number | undefined;
    readonly webSearch?: boolean | undefined;
  }
>()("top/BotKit") {}

const addBot = (name: string, description: string, newBot: NewBot, avatar = 0) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const instructions = newBot.instructions(name, description);
    return yield* store.transaction(
      Effect.gen(function* () {
        const id = yield* store.createBot(name, instructions, newBot.model, description, avatar);
        const system = createInitialSystemMessage(instructions, newBot.declare.map(toToolDeclaration));
        if (system) yield* store.append(id, "system", system);
        return id;
      }),
    );
  });

export const ensureBots = (names: readonly string[], newBot: NewBot) =>
  Effect.gen(function* () {
    const store = yield* Store;
    if (yield* store.flag("seeded")) return;
    if ((yield* store.bots).length === 0) for (const name of names) yield* addBot(name, "", newBot);
    yield* store.setFlag("seeded");
  });

type LiveBot = {
  readonly runner: BotRunner;
  readonly scope: Scope.Closeable;
  folder: FilesFolder | undefined;
  summary: BotSummary;
};

export class Daemon extends Context.Service<
  Daemon,
  {
    readonly bots: () => BotSummary[];
    readonly has: (bot: number) => boolean;
    readonly runner: (bot: number) => Effect.Effect<BotRunner, UnknownBotError>;
    readonly runners: () => BotRunner[];
    readonly createBot: (name: string, description: string, avatar?: number) => Effect.Effect<number, BotError>;
    readonly setWebSearch: (bot: number, on: boolean) => Effect.Effect<void, UnknownBotError | BotError>;
    readonly deleteBot: (id: number) => Effect.Effect<void, UnknownBotError>;
    readonly submit: (
      bot: number,
      requestId: string,
      text: string,
      whenBusy: WhenBusy,
      clientId: string | null,
      attachmentIds?: readonly string[],
    ) => Effect.Effect<{ duplicate: boolean }, UnknownBotError | BusyError | AttachmentError>;
    readonly stop: (bot: number) => Effect.Effect<void, UnknownBotError>;
    readonly start: Effect.Effect<void>;
    readonly changed: (bot: number) => Effect.Effect<void>;
    readonly toolsOf: (bot: number) => readonly TopTool[];
    readonly hasFiles: boolean;
    readonly files: (bot: number) => FilesFolder | undefined;
    readonly jobs: Jobs;
    readonly wakes: WakeClock;
    readonly permissions: Permissions;
    readonly skills: Skills | undefined;
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
  const toolSources = new Map<number, () => readonly TopTool[]>();
  const dirty = yield* FiberMap.make<number>();

  if (kit.newBot && kit.firstBots) yield* ensureBots(kit.firstBots, kit.newBot);
  if (kit.newBot) for (const bot of yield* store.bots) if (bot.model !== kit.newBot.model) yield* store.setModel(bot.id, kit.newBot.model);
  const seeded = (yield* store.bots)[0];
  if (kit.seed && seeded) yield* seedHistory(seeded.id, kit.seed);

  const waiting = (bot: number): Effect.Effect<{ background?: number; approvals?: number; wakeAt?: number }> =>
    Effect.gen(function* () {
      const background = jobs.count(bot);
      const approvals = (yield* store.waitingOf(bot)).length;
      const wakeAt = (yield* store.wakes(bot))[0]?.dueAt;
      return { ...(background ? { background } : {}), ...(approvals ? { approvals } : {}), ...(wakeAt !== undefined ? { wakeAt } : {}) };
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
        ...(row.avatar ? { avatar: row.avatar } : {}),
        status: status.status,
        ...(status.tool ? { tool: status.tool } : {}),
        ...(status.error ? { error: status.error } : {}),
        ...(status.searching ? { searching: true as const } : {}),
        since: status.since,
        preview: lastLine(textOf(answer?.content)),
        queued: (yield* store.inbox(bot)).length,
        ...(yield* waiting(bot)),
        lastSeq: yield* store.lastSeq(bot),
        ...(kit.webSearch ? { webSearch: row.webSearch } : {}),
      } satisfies BotSummary;
    });

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

  const queued = (row: InboxRow): Effect.Effect<void> =>
    Effect.gen(function* () {
      const live = bots.get(row.bot);
      if (!live) return;
      yield* events.publish({ _tag: "Inbox", bot: row.bot });
      yield* touch(row.bot);
      yield* live.runner.submitted(row);
    });

  const changed = (bot: number): Effect.Effect<void> => (bots.has(bot) ? touch(bot) : Effect.void);
  const jobs: Jobs = yield* makeJobs({ deliver: queued, changed }, kit.foregroundMs, kit.repeatGapMs);
  const wakes = yield* makeWakeClock(queued);
  const toolsOf = (bot: number) => toolSources.get(bot)?.() ?? [];
  const permissions = makePermissions(store, {
    entry: (entry) => (bots.has(entry.bot) ? Effect.andThen(events.publish({ _tag: "Entry", entry }), touch(entry.bot)) : Effect.void),
    deliver: queued,
    changed: (bot) => Effect.andThen(events.publish({ _tag: "Permissions" }), changed(bot)),
  });
  const collar = collarTools({ store, jobs, wakes, permissions, changed, toolsOf });
  const skills = kit.skills
    ? yield* makeSkills(kit.skills, (view) => events.publish({ _tag: "Skills", view })).pipe(Effect.provideService(FileSystem.FileSystem, fs))
    : undefined;

  const add = (bot: BotRow): Effect.Effect<LiveBot> =>
    Effect.gen(function* () {
      const botScope = yield* Scope.fork(scope);
      const isLive = () => bots.get(bot.id)?.scope === botScope;
      const announce = (entry: StoredEntry) =>
        Effect.suspend(() => {
          if (!isLive()) return Effect.void;
          return Effect.andThen(events.publish({ _tag: "Entry", entry }), entry.kind !== "system" ? touch(bot.id) : Effect.void);
        });
      const own = [...(typeof kit.tools === "function" ? yield* kit.tools(bot) : kit.tools), ...collar];
      const plain = mcp ? () => [...own, ...mcp.toolsFor(bot.id)] : () => own;
      toolSources.set(bot.id, plain);
      const wrapped = own.map(jobs.wrap);
      const tools = mcp ? () => [...wrapped, ...mcp.toolsFor(bot.id).map(jobs.wrap)] : () => wrapped;
      const fixed = kit.sections ? yield* kit.sections(bot) : undefined;
      const searchOn = Effect.map(store.bot(bot.id), (row) => row?.webSearch === true);
      const changing = [
        ...(skills ? [Effect.map(skills.section(bot), (section) => ({ skills: section }))] : []),
        ...(kit.webSearch ? [Effect.map(searchOn, (on) => ({ web_search: on ? WEB_SEARCH_SECTION : null }))] : []),
      ];
      const sections =
        changing.length > 0
          ? Effect.map(Effect.all(changing), (parts): Readonly<Record<string, string | null>> => Object.assign({ ...fixed }, ...parts))
          : fixed && Effect.succeed(fixed);
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
          sections,
          note: skills ? (text) => skills.note(bot, text) : undefined,
          gatherMs: kit.gatherMs,
          attachments,
          retryDelaysMs: kit.retryDelaysMs,
          compactAtTokens: kit.compactAtTokens,
          webSearch: kit.webSearch ? searchOn : undefined,
        },
      ).pipe(Scope.provide(botScope));
      const live: LiveBot = { runner, scope: botScope, folder: undefined, summary: yield* summarize(bot.id, runner) };
      bots.set(bot.id, live);
      if (kit.files) {
        const path = kit.files(bot);
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
    createBot: Effect.fn("Daemon.createBot")(function* (rawName, rawDescription, avatar = 0) {
      const newBot = kit.newBot;
      if (!newBot) return yield* new BotError({ message: "This daemon can't make bots." });
      const name = rawName.trim().replace(/\s+/g, " ");
      const description = rawDescription.trim();
      if (!name) return yield* new BotError({ message: "Give the bot a name." });
      if (name.length > MAX_BOT_NAME) return yield* new BotError({ message: `Keep the name under ${MAX_BOT_NAME + 1} characters.` });
      if (description.length > MAX_BOT_DESCRIPTION)
        return yield* new BotError({ message: `Keep the description under ${MAX_BOT_DESCRIPTION + 1} characters.` });
      if (avatar < 0 || avatar > MAX_BOT_AVATAR) return yield* new BotError({ message: "That icon doesn't exist." });
      const taken = [...bots.values()].some((live) => live.runner.name.toLowerCase() === name.toLowerCase());
      if (taken) return yield* new BotError({ message: `There's already a bot named ${name}.` });
      const id = yield* addBot(name, description, newBot, avatar).pipe(Effect.provideService(Store, store));
      const live = yield* add((yield* store.bot(id))!);
      yield* events.publish({ _tag: "Bot", summary: live.summary });
      if (skills) yield* skills.rescan;
      return id;
    }),
    setWebSearch: Effect.fn("Daemon.setWebSearch")(function* (bot, on) {
      if (!bots.has(bot)) return yield* new UnknownBotError({ bot });
      if (!kit.webSearch)
        return yield* new BotError({
          message: `Web search is OpenAI's, on its Responses API; the bots run on ${kit.newBot?.model ?? "a model"}, which can't use it.`,
        });
      yield* store.setWebSearch(bot, on);
      yield* touch(bot);
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
      yield* events.publish({ _tag: "Permissions" });
      if (mcp) yield* mcp.botRemoved(id);
      if (skills) yield* skills.rescan;
      const { runner } = live;
      yield* runner.close;
      yield* runner.abort;
      yield* jobs.stopAll(id);
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
      yield* permissions.withdraw(bot);
    }),
    start: Effect.gen(function* () {
      const lost = yield* jobs.recover((bot, name) => toolsOf(bot).find((tool) => tool.name === name));
      if (lost) yield* Effect.log(`${lost} background job${lost === 1 ? " was" : "s were"} cut off by the restart`);
      const planned = yield* store.flag(PLANNED_RESTART);
      if (planned) yield* store.clearFlag(PLANNED_RESTART);
      for (const live of bots.values()) {
        const report = yield* live.runner.recover(planned);
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
    permissions,
    skills,
  });
});

export const layer: Layer.Layer<Daemon, never, Store | Events | BotKit | FileSystem.FileSystem> = Layer.effect(Daemon, make);
