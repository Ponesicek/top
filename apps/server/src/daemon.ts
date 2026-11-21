import { createInitialSystemMessage, type Models, toToolDeclaration } from "@earendil-works/pi-ai";
import {
  type Attachment,
  AttachmentError,
  BotError,
  type BotRuntimesView,
  type BotSummary,
  BusyError,
  type ContextFileName,
  type ContextFileView,
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
import * as Semaphore from "effect/Semaphore";
import { type Asks, makeAsks } from "./asks.ts";
import { Attachments } from "./attachments.ts";
import { collarTools } from "./collar/index.ts";
import { contextSections, hasContextFiles, readContextFile, readContextFiles, saveContextFile, seedSoul, soulIdentity } from "./contextFiles.ts";
import { Events } from "./events.ts";
import { type FilesFolder, makeFilesFolder } from "./files.ts";
import { type Jobs, makeJobs } from "./jobs.ts";
import type { ThinkingLevel } from "./loop.ts";
import { Mcp } from "./mcp.ts";
import { type BotRunner, makeRunner } from "./runner.ts";
import { type BotRuntime, CLAUDE_PROVIDER, runtimeOf, topRuntime, unavailable } from "./runtime.ts";
import { Secrets } from "./secrets.ts";
import { seedHistory } from "./seed.ts";
import { makeSkills, type Skills, type SkillsConfig } from "./skills.ts";
import { type BotRow, type InboxRow, PLANNED_RESTART, Store, type StoredEntry } from "./store.ts";
import { makeTasks, type Tasks } from "./tasks/coordinator.ts";
import type { HarnessAdapter } from "./tasks/harness.ts";
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
      .replace(/\s*\ue200cite(?:\ue202[^\ue200\ue201\ue202]*)+\ue201/g, "")
      .trim();
    if (line) return line.slice(0, 120);
  }
  return "";
}

export type NewBot = {
  readonly model: string;
  readonly instructions: string;
  readonly declare: readonly TopTool[];
};

export const DEFAULT_INSTRUCTIONS = "You are one of the user's bots.";

/** Claude Code on the daemon's computer, as Top can tell without running a bot on it. */
export type ClaudeCliStatus = { readonly ok: true; readonly version: string } | { readonly ok: false; readonly error: string };

/** Bots on the Claude Agent SDK (`claude/<model>`), when this daemon can run them. */
export type ClaudeBots = {
  readonly runtime: (bot: BotRow) => BotRuntime;
  readonly status: Effect.Effect<ClaudeCliStatus>;
};

/** The models a Claude bot can pick from; `default` is whatever Claude Code itself would use. */
export const CLAUDE_MODELS = ["default", "opus", "sonnet", "haiku"] as const;

export class BotKit extends Context.Service<
  BotKit,
  {
    readonly models: Models;
    readonly tools: readonly TopTool[] | ((bot: BotRow) => Effect.Effect<readonly TopTool[]>);
    readonly thinking: ThinkingLevel;
    readonly sections?: ((bot: BotRow) => Effect.Effect<Readonly<Record<string, string>>>) | undefined;
    readonly folder?: ((bot: Pick<BotRow, "name">) => string) | undefined;
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
    readonly harnesses?: readonly HarnessAdapter[] | undefined;
    readonly claude?: ClaudeBots | undefined;
    readonly maxTasks?: number | undefined;
    readonly taskCancelGraceMs?: number | undefined;
  }
>()("top/BotKit") {}

const addBot = (name: string, newBot: NewBot, avatar = 0, model = newBot.model) =>
  Effect.gen(function* () {
    const store = yield* Store;
    return yield* store.transaction(
      Effect.gen(function* () {
        const id = yield* store.createBot(name, model, avatar);
        const system = createInitialSystemMessage(newBot.instructions, newBot.declare.map(toToolDeclaration));
        if (system) yield* store.append(id, "system", system);
        return id;
      }),
    );
  });

export const ensureBots = (names: readonly string[], newBot: NewBot, folder: ((bot: Pick<BotRow, "name">) => string) | undefined) =>
  Effect.gen(function* () {
    const store = yield* Store;
    if (yield* store.flag("seeded")) return;
    if ((yield* store.bots).length === 0)
      for (const name of names) {
        if (folder) yield* Effect.orDie(seedSoul(folder({ name }), name, ""));
        yield* addBot(name, newBot);
      }
    yield* store.setFlag("seeded");
  });

export const moveLegacySouls = (folder: (bot: Pick<BotRow, "name">) => string) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const owners = new Map<string, BotRow>();
    for (const bot of yield* store.bots) if (!owners.has(folder(bot).toLowerCase())) owners.set(folder(bot).toLowerCase(), bot);
    for (const soul of yield* store.legacySouls) {
      const owner = owners.get(folder(soul).toLowerCase());
      if (owner && owner.id !== soul.bot) {
        yield* Effect.logError(
          `${soul.name}: its folder is ${owner.name}'s too, so its name and description stay in the database rather than go into ${owner.name}'s SOUL.md`,
        );
        continue;
      }
      const moved = yield* Effect.result(seedSoul(folder(soul), soul.name, soul.description));
      if (moved._tag === "Failure") {
        yield* Effect.logError(`${soul.name}: couldn't move its name and description into SOUL.md; they stay in the database until it can`, moved.failure);
        continue;
      }
      yield* store.settleLegacySoul(soul.bot);
      if (moved.success === "appended") yield* Effect.log(`${soul.name}: its SOUL.md was there already, so its old description was added at the end`);
    }
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
    readonly createBot: (name: string, description: string, avatar?: number, model?: string) => Effect.Effect<number, BotError>;
    /** Gives a Claude bot another Claude model, from its next message. A bot can't move between runtimes: each keeps its own conversation. */
    readonly setBotModel: (bot: number, model: string) => Effect.Effect<void, UnknownBotError | BotError>;
    /** What new bots can run on here, and whether Claude Code is ready for them. */
    readonly runtimes: Effect.Effect<BotRuntimesView>;
    /** Lists the bots in this order, on every client. Bots it leaves out keep their place after the ones it names. */
    readonly setBotOrder: (ids: readonly number[]) => Effect.Effect<void>;
    readonly contextFiles: (bot: number) => Effect.Effect<readonly ContextFileView[], UnknownBotError | BotError>;
    readonly saveContextFile: (
      bot: number,
      name: ContextFileName,
      content: string,
      version: string,
    ) => Effect.Effect<{ version: string }, UnknownBotError | BotError>;
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
    readonly asks: Asks;
    readonly skills: Skills | undefined;
    readonly tasks: Tasks | undefined;
  }
>()("top/Daemon") {}

const make = Effect.gen(function* () {
  const store = yield* Store;
  const events = yield* Events;
  const kit = yield* BotKit;
  const secrets = yield* Secrets;
  const fs = yield* FileSystem.FileSystem;
  const mcp = Option.getOrUndefined(yield* Effect.serviceOption(Mcp));
  const attachments = Option.getOrUndefined(yield* Effect.serviceOption(Attachments));
  const scope = yield* Effect.scope;
  const bots = new Map<number, LiveBot>();
  const toolSources = new Map<number, () => readonly TopTool[]>();
  const dirty = yield* FiberMap.make<number>();
  const saving = yield* Semaphore.make(1);
  const ordering = yield* Semaphore.make(1);

  if (kit.newBot && kit.firstBots) yield* ensureBots(kit.firstBots, kit.newBot, kit.folder).pipe(Effect.provideService(FileSystem.FileSystem, fs));
  if (kit.folder) yield* moveLegacySouls(kit.folder).pipe(Effect.provideService(FileSystem.FileSystem, fs));
  // `--model` is the model of every bot on Top's own loop. A Claude bot keeps the model it was given.
  if (kit.newBot)
    for (const bot of yield* store.bots) if (runtimeOf(bot.model) === "top" && bot.model !== kit.newBot.model) yield* store.setModel(bot.id, kit.newBot.model);
  const seeded = (yield* store.bots)[0];
  if (kit.seed && seeded) yield* seedHistory(seeded.id, kit.seed);

  const waiting = (bot: number): Effect.Effect<{ background?: number; asks?: number; wakeAt?: number }> =>
    Effect.gen(function* () {
      const background = jobs.count(bot);
      const asks = (yield* store.waitingOf(bot)).length;
      const wakeAt = (yield* store.wakes(bot))[0]?.dueAt;
      return { ...(background ? { background } : {}), ...(asks ? { asks } : {}), ...(wakeAt !== undefined ? { wakeAt } : {}) };
    });

  const summarize = (bot: number, runner: BotRunner | undefined): Effect.Effect<BotSummary> =>
    Effect.gen(function* () {
      const row = (yield* store.bot(bot))!;
      const status = runner?.status() ?? { status: "idle" as const, since: yield* Clock.currentTimeMillis };
      const answer = yield* store.lastAnswer(bot);
      const soul = kit.folder
        ? soulIdentity((yield* readContextFile(kit.folder(row), "SOUL.md").pipe(Effect.provideService(FileSystem.FileSystem, fs))).content)
        : {};
      return {
        id: bot,
        name: soul.name ?? row.name,
        description: soul.about ?? "",
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
        ...(runtimeOf(row.model) === "claude" ? { model: row.model } : {}),
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
  const asks = makeAsks(store, secrets, {
    entry: (entry) => (bots.has(entry.bot) ? Effect.andThen(events.publish({ _tag: "Entry", entry }), touch(entry.bot)) : Effect.void),
    deliver: queued,
    changed: (bot) => Effect.andThen(events.publish({ _tag: "Asks" }), changed(bot)),
  });
  const tasks: Tasks | undefined = kit.harnesses?.length
    ? yield* makeTasks(
        store.tasks,
        {
          adapters: kit.harnesses,
          maxRunning: kit.maxTasks,
          cancelGraceMs: kit.taskCancelGraceMs,
          hide: secrets.redact,
          folder: (bot) => Effect.map(store.bot(bot), (row) => (row && kit.folder ? kit.folder(row) : undefined)),
        },
        { deliver: queued, publish: (waiting) => events.publish({ _tag: "WaitingTasks", tasks: waiting }) },
      )
    : undefined;
  const collar = collarTools({ store, jobs, wakes, asks, tasks, changed, toolsOf });
  const skills = kit.skills
    ? yield* makeSkills(kit.skills, (view) => events.publish({ _tag: "Skills", view })).pipe(Effect.provideService(FileSystem.FileSystem, fs))
    : undefined;

  const runtimeFor = (bot: BotRow): Effect.Effect<BotRuntime> => {
    if (runtimeOf(bot.model) === "claude") {
      if (kit.claude) return Effect.succeed(kit.claude.runtime(bot));
      return Effect.succeed(unavailable(`${bot.name} runs on Claude Code, which this daemon doesn't run.`));
    }
    const slash = bot.model.indexOf("/");
    const model = kit.models.getModel(bot.model.slice(0, slash), bot.model.slice(slash + 1));
    if (!model) return Effect.die(new Error(`Bot ${bot.name}: unknown model ${bot.model}`));
    return Effect.succeed(topRuntime(kit.models, model));
  };

  const add = (bot: BotRow): Effect.Effect<LiveBot> =>
    Effect.gen(function* () {
      const botScope = yield* Scope.fork(scope);
      const isLive = () => bots.get(bot.id)?.scope === botScope;
      const announce = (entry: StoredEntry) =>
        Effect.suspend(() => {
          if (!isLive()) return Effect.void;
          return Effect.andThen(events.publish({ _tag: "Entry", entry }), entry.kind !== "system" ? touch(bot.id) : Effect.void);
        });
      const own = [...(typeof kit.tools === "function" ? yield* kit.tools(bot) : kit.tools), ...collar].map(secrets.guard);
      const servers = () => (mcp ? mcp.toolsFor(bot.id).map(secrets.guard) : []);
      toolSources.set(bot.id, () => [...own, ...servers()]);
      const wrapped = own.map(jobs.wrap);
      const tools = () => [...wrapped, ...servers().map(jobs.wrap)];
      const fixed = kit.sections ? yield* kit.sections(bot) : undefined;
      const runtime = yield* runtimeFor(bot);
      // OpenAI's web search is part of the model request on Top's own loop; Claude bots don't get it.
      const webSearch = kit.webSearch === true && runtime.id === "top";
      // Every bot on a model that can search may search. The stored per-bot flag, from when it was a setting, isn't read.
      const searchOn = Effect.succeed(true);
      const folder = kit.folder?.(bot);
      const changing = [
        ...(skills ? [Effect.map(skills.section(bot), (section) => ({ skills: section }))] : []),
        ...(webSearch ? [Effect.succeed({ web_search: WEB_SEARCH_SECTION })] : []),
        ...(folder
          ? [Effect.map(readContextFiles(folder).pipe(Effect.provideService(FileSystem.FileSystem, fs)), (files) => contextSections(folder, bot.name, files))]
          : []),
      ];
      const sections =
        changing.length > 0
          ? Effect.map(Effect.all(changing), (parts): Readonly<Record<string, string | null>> => Object.assign({ ...fixed }, ...parts))
          : fixed && Effect.succeed(fixed);
      const runner = yield* makeRunner(
        bot,
        runtime,
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
          webSearch: webSearch ? searchOn : undefined,
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

  const checkClaudeModel = (model: string) =>
    Effect.gen(function* () {
      if (runtimeOf(model) !== "claude")
        return yield* new BotError({ message: `Bots here run on ${kit.newBot?.model ?? "the daemon's model"} or on Claude Code (claude/<model>).` });
      if (!kit.claude) return yield* new BotError({ message: "This daemon doesn't run bots on Claude Code." });
      const name = model.slice(CLAUDE_PROVIDER.length + 1);
      if (!(CLAUDE_MODELS as readonly string[]).includes(name) && !/^claude-[a-z0-9.-]+$/.test(name))
        return yield* new BotError({ message: `Claude Code has no model "${name}" Top knows of. Pick ${CLAUDE_MODELS.join(", ")}, or a full claude-… id.` });
    });

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
    createBot: Effect.fn("Daemon.createBot")(function* (rawName, rawDescription, avatar = 0, rawModel) {
      const newBot = kit.newBot;
      if (!newBot) return yield* new BotError({ message: "This daemon can't make bots." });
      const model = rawModel ?? newBot.model;
      if (model !== newBot.model) yield* checkClaudeModel(model);
      const name = rawName.trim().replace(/\s+/g, " ");
      const description = rawDescription.trim();
      const folder = kit.folder;
      if (!name) return yield* new BotError({ message: "Give the bot a name." });
      if (name.length > MAX_BOT_NAME) return yield* new BotError({ message: `Keep the name under ${MAX_BOT_NAME + 1} characters.` });
      if (description.length > MAX_BOT_DESCRIPTION)
        return yield* new BotError({ message: `Keep the description under ${MAX_BOT_DESCRIPTION + 1} characters.` });
      if (avatar < 0 || avatar > MAX_BOT_AVATAR) return yield* new BotError({ message: "That icon doesn't exist." });
      const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
      for (const live of bots.values()) {
        if (same(live.runner.name, name) || same(live.summary.name, name))
          return yield* new BotError({
            message: `There's already a bot named ${name}${same(live.summary.name, name) ? "" : ` (it's called ${live.summary.name} now)`}.`,
          });
        if (folder && same(folder(live.runner), folder({ name })))
          return yield* new BotError({ message: `${name} would share ${live.summary.name}'s folder, ${folder({ name })}. Pick another name.` });
      }
      if (folder) {
        const path = folder({ name });
        const left = yield* hasContextFiles(path).pipe(Effect.provideService(FileSystem.FileSystem, fs));
        if (left.length)
          return yield* new BotError({ message: `${path} still has ${left.join(", ")} from an earlier bot. Move them away, or pick another name.` });
        yield* seedSoul(path, name, description, true).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.mapError((error) => new BotError({ message: `Couldn't write ${name}'s SOUL.md: ${error.message}` })),
        );
      }
      const id = yield* addBot(name, newBot, avatar, model).pipe(Effect.provideService(Store, store));
      const live = yield* add((yield* store.bot(id))!);
      yield* events.publish({ _tag: "Bot", summary: live.summary });
      if (skills) yield* skills.rescan;
      return id;
    }),
    setBotModel: Effect.fn("Daemon.setBotModel")(function* (bot, model) {
      const row = bots.has(bot) ? yield* store.bot(bot) : undefined;
      if (!row) return yield* new UnknownBotError({ bot });
      if (runtimeOf(row.model) !== "claude")
        return yield* new BotError({ message: `${row.name} runs on Top's own loop, on the daemon's model (${row.model}); \`--model\` sets it.` });
      yield* checkClaudeModel(model);
      yield* store.setModel(bot, model);
      yield* touch(bot);
    }),
    runtimes: Effect.gen(function* () {
      const status = kit.claude ? yield* kit.claude.status : undefined;
      return {
        model: kit.newBot?.model ?? "",
        claude: kit.claude !== undefined,
        ...(status?.ok ? { claudeVersion: status.version } : status ? { claudeProblem: status.error } : {}),
        claudeModels: kit.claude ? [...CLAUDE_MODELS] : [],
      };
    }),
    contextFiles: Effect.fn("Daemon.contextFiles")(function* (bot) {
      const row = bots.has(bot) ? yield* store.bot(bot) : undefined;
      if (!row) return yield* new UnknownBotError({ bot });
      if (!kit.folder) return yield* new BotError({ message: "This daemon's bots have no folder for their files." });
      return yield* readContextFiles(kit.folder(row)).pipe(Effect.provideService(FileSystem.FileSystem, fs));
    }),
    saveContextFile: Effect.fn("Daemon.saveContextFile")(function* (bot, name, content, version) {
      const row = bots.has(bot) ? yield* store.bot(bot) : undefined;
      if (!row) return yield* new UnknownBotError({ bot });
      if (!kit.folder) return yield* new BotError({ message: "This daemon's bots have no folder for their files." });
      const saved = yield* saving.withPermits(1)(
        saveContextFile(kit.folder(row), name, content, version).pipe(Effect.provideService(FileSystem.FileSystem, fs)),
      );
      yield* touch(bot);
      return { version: saved };
    }),
    setBotOrder: Effect.fn("Daemon.setBotOrder")(function* (ids) {
      yield* ordering.withPermits(1)(
        Effect.gen(function* () {
          const named = [...new Set(ids)].filter((id) => bots.has(id));
          const order = [...named, ...[...bots.keys()].filter((id) => !named.includes(id))];
          yield* store.setBotOrder(order);
          // The roster as it is now, not as it was before the write: a bot deleted meanwhile stays gone, and one made
          // meanwhile stays, after the ordered ones (the store lists it there too).
          const rank = new Map(order.map((id, i) => [id, i]));
          const live = [...bots.entries()].sort(([a], [b]) => (rank.get(a) ?? order.length) - (rank.get(b) ?? order.length));
          bots.clear();
          for (const [id, bot] of live) bots.set(id, bot);
        }),
      );
      yield* events.publish({ _tag: "BotOrder" });
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
      yield* events.publish({ _tag: "Asks" });
      yield* secrets.removeBot(id);
      if (mcp) yield* mcp.botRemoved(id);
      if (skills) yield* skills.rescan;
      const { runner } = live;
      yield* runner.close;
      yield* runner.abort;
      yield* jobs.stopAll(id);
      yield* Effect.forkIn(
        Effect.gen(function* () {
          if (tasks) yield* tasks.stopAll(id, true);
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
      yield* asks.withdraw(bot);
      if (tasks) yield* Effect.forkIn(tasks.stopAll(bot), scope);
    }),
    start: Effect.gen(function* () {
      const lost = yield* jobs.recover((bot, name) => toolsOf(bot).find((tool) => tool.name === name));
      if (lost) yield* Effect.log(`${lost} background job${lost === 1 ? " was" : "s were"} cut off by the restart`);
      const cut = tasks ? yield* tasks.recover : 0;
      if (cut) yield* Effect.log(`${cut} harness task${cut === 1 ? " was" : "s were"} cut off by the restart`);
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
    asks,
    skills,
    tasks,
  });
});

export const layer: Layer.Layer<Daemon, never, Store | Events | BotKit | Secrets | FileSystem.FileSystem> = Layer.effect(Daemon, make);
