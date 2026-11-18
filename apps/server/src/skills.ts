import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import {
  type ActiveSkill,
  activeSkills,
  type BotSkills,
  MAX_SKILL_DESCRIPTION,
  MAX_SKILL_NAME,
  SKILL_NAME,
  SkillError,
  type SkillFolder,
  type SkillFolderAdded,
  type SkillFolderEntry,
  type SkillsView,
  type SkillUse,
  type SkillView,
  skillInvocation,
} from "@top/protocol";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Semaphore from "effect/Semaphore";
import type { UserText } from "./messages.ts";
import { type BotRow, Store } from "./store.ts";

export const LOCAL_SKILLS = join(".agents", "skills");
const SKILL_FILE = "SKILL.md";
/** Agent Skills frontmatter (as in Claude Code): `true` keeps the skill out of the bot's instructions, for `/<name>` only. */
const DISABLE_MODEL_INVOCATION = "disable-model-invocation";
export const MAX_SKILL_BYTES = 256 * 1024;

export type SkillsConfig = {
  readonly library: string;
  readonly local: (bot: BotRow) => string;
};

const messageOf = (error: unknown) => {
  const cause = error instanceof Error && "cause" in error && error.cause instanceof Error ? error.cause : error;
  return cause instanceof Error ? cause.message : String(cause);
};

type Checked = { readonly description: string; readonly manual?: true; readonly error?: string };

function checkFrontmatter(name: string, content: string): Checked {
  let frontmatter: Record<string, unknown>;
  try {
    frontmatter = parseFrontmatter(content).frontmatter;
  } catch (error) {
    return { description: "", error: `Its frontmatter isn't valid YAML: ${messageOf(error).split("\n")[0]}` };
  }
  const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
  const fail = (error: string) => ({ description, error });
  if (!content.replace(/^\uFEFF/, "").startsWith("---")) return fail("SKILL.md has no frontmatter: it starts with --- and gives a name and a description.");
  if (frontmatter.name === undefined) return fail("Its frontmatter has no name.");
  if (frontmatter.name !== name) return fail(`Its frontmatter's name (${JSON.stringify(frontmatter.name)}) isn't its folder's name.`);
  if (!description) return fail("Its frontmatter has no description, which is how a bot knows when to use it.");
  if (description.length > MAX_SKILL_DESCRIPTION) return fail(`Its description is over ${MAX_SKILL_DESCRIPTION} characters.`);
  const manual = frontmatter[DISABLE_MODEL_INVOCATION];
  if (manual === undefined || manual === null || manual === false || manual === "false") return { description };
  if (manual === true || manual === "true") return { description, manual: true };
  return fail(`Its frontmatter's ${DISABLE_MODEL_INVOCATION} is ${JSON.stringify(manual)}, which isn't true or false.`);
}

const readSkill = (dir: string, name: string): Effect.Effect<SkillView | undefined, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const folder = join(dir, name);
    const path = join(folder, SKILL_FILE);
    const link = yield* Effect.result(fs.readLink(folder));
    const linkedFrom = link._tag === "Success" ? dirname(resolve(dir, link.success)) : undefined;
    const skill = (checked: Checked): SkillView => ({
      name,
      description: checked.description,
      path,
      ...(checked.error ? { error: checked.error } : {}),
      ...(checked.manual && !checked.error ? { manual: true } : {}),
      ...(linkedFrom ? { linkedFrom } : {}),
    });
    const broken = (error: string) => skill({ description: "", error });
    const info = yield* Effect.result(fs.stat(folder));
    if (info._tag === "Failure") return link._tag === "Success" ? broken(`It's a link to ${link.success}, which isn't there.`) : undefined;
    if (info.success.type !== "Directory") return undefined;
    if (name.length > MAX_SKILL_NAME || !SKILL_NAME.test(name))
      return broken(`Its folder's name is its name, which takes lowercase letters, digits and single hyphens (up to ${MAX_SKILL_NAME}).`);
    const file = yield* Effect.result(fs.stat(path));
    if (file._tag === "Failure") return broken("There's no SKILL.md in its folder.");
    if (file.success.type !== "File") return broken("Its SKILL.md isn't a file.");
    if (Number(file.success.size) > MAX_SKILL_BYTES) return broken(`Its SKILL.md is over ${MAX_SKILL_BYTES / 1024} KB.`);
    const content = yield* Effect.result(fs.readFileString(path));
    if (content._tag === "Failure") return broken(`Its SKILL.md can't be read: ${messageOf(content.failure)}`);
    return skill(checkFrontmatter(name, content.success));
  });

export const scanSkills = (dir: string): Effect.Effect<SkillView[], never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const names = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed((): string[] => []));
    const found: SkillView[] = [];
    for (const name of names.filter((n) => !n.startsWith(".")).sort()) {
      const skill = yield* readSkill(dir, name);
      if (skill) found.push(skill);
    }
    return found;
  });

export const escapeXml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const folderOf = (skill: Pick<SkillView, "path">) => skill.path.slice(0, -(SKILL_FILE.length + 1));

export function skillsSection(skills: readonly ActiveSkill[], where: { readonly library: string; readonly local: string }): string | null {
  // A skill that asks not to be invoked by the model stays out: the bot gets it only with a message that starts with /<name>.
  const usable = skills.filter((skill) => !skill.error && !skill.manual);
  if (!usable.length) return null;
  return [
    "<skills>",
    "Skills are folders of instructions, scripts and references for particular tasks. The user switched these on for you. When a task matches a skill's description, read its SKILL.md first and follow it. A message that starts with /<name> asks for that skill, and its SKILL.md comes with the message.",
    "Paths in a skill (scripts/, references/, assets/) are relative to its folder, the one holding SKILL.md, not to your working folder: use absolute paths, or run commands from the skill's folder.",
    `Shared skills are in ${where.library}. Every bot that has one uses those same files, so changing a shared skill changes it for all of them. Your own skills are in ${where.local}; one of yours takes the place of a shared skill with the same name. You can edit both with your tools. A skill you add is used once the user switches it on for you.`,
    "<available_skills>",
    ...usable.map((skill) =>
      [
        "  <skill>",
        `    <name>${escapeXml(skill.name)}</name>`,
        `    <description>${escapeXml(skill.description)}</description>`,
        `    <source>${skill.source === "shared" ? "shared" : "yours"}</source>`,
        `    <location>${escapeXml(skill.path)}</location>`,
        "  </skill>",
      ].join("\n"),
    ),
    "</available_skills>",
    "</skills>",
  ].join("\n");
}

export const invocationNote = (skill: ActiveSkill): Effect.Effect<UserText, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const where = skill.source === "shared" ? "a shared skill: every bot that has it uses these same files" : "one of your own skills";
    const read: { readonly content: string } | { readonly error: string } = skill.error
      ? { error: skill.error }
      : yield* Effect.gen(function* () {
          const info = yield* fs.stat(skill.path);
          if (Number(info.size) > MAX_SKILL_BYTES) return { error: `Its SKILL.md is over ${MAX_SKILL_BYTES / 1024} KB.` };
          return { content: yield* fs.readFileString(skill.path) };
        }).pipe(Effect.catch((failure) => Effect.succeed({ error: `Its SKILL.md can't be read: ${messageOf(failure)}` })));
    const use: SkillUse = { name: skill.name, source: skill.source, path: skill.path, ...("error" in read ? { error: read.error } : {}) };
    if ("error" in read)
      return {
        type: "text",
        text: `[The user asked for the skill "${skill.name}" (/${skill.name}), but it can't be used: ${read.error} Tell them.]`,
        skill: use,
      };
    return {
      type: "text",
      text: [
        `[The user asked for the skill "${skill.name}" (/${skill.name}), ${where}. Its SKILL.md is below, from ${skill.path}. Paths in it are relative to ${folderOf(skill)}: use absolute paths, or run commands from that folder.]`,
        `<skill name="${escapeXml(skill.name)}" location="${escapeXml(skill.path)}">`,
        read.content.trim(),
        "</skill>",
      ].join("\n"),
      skill: use,
    };
  });

/** A skill in a folder being added, and the folder the library would link to. */
type Candidate = SkillFolderEntry & { readonly source: string };

const expandHome = (path: string) => (path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);

/**
 * What adding `raw` to the library would do. It's a folder of skill folders (a collection, like a cloned repository's
 * skills/) or one skill's own folder. Nothing in the library is replaced: a name that's taken stays as it is.
 */
export const inspectSkillFolder = (
  library: string,
  raw: string,
): Effect.Effect<{ readonly folder: string; readonly skills: readonly Candidate[] }, SkillError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const given = expandHome(raw.trim());
    if (!given) return yield* new SkillError({ message: "Give the path of a folder of skills on the daemon's computer." });
    if (!isAbsolute(given))
      return yield* new SkillError({ message: `Give the folder's full path on the daemon's computer (it may start with ~): ${raw.trim()} isn't one.` });
    const folder = resolve(given);
    const info = yield* Effect.result(fs.stat(folder));
    if (info._tag === "Failure") return yield* new SkillError({ message: `There's no folder at ${folder}.` });
    if (info.success.type !== "Directory") return yield* new SkillError({ message: `${folder} isn't a folder.` });
    const real = (path: string) => Effect.orElseSucceed(fs.realPath(path), () => undefined);
    const realFolder = yield* real(folder);
    const realLibrary = (yield* real(library)) ?? library;
    const within = (path: string | undefined, dir: string) => path !== undefined && (path === dir || path.startsWith(dir + sep));
    if (within(folder, resolve(library)) || within(realFolder, realLibrary))
      return yield* new SkillError({ message: `${folder} is in the shared library already: its skills are there to switch on.` });

    const single = yield* Effect.result(fs.stat(join(folder, SKILL_FILE)));
    const found: { skill: SkillView; source: string }[] = [];
    if (single._tag === "Success") {
      const skill = yield* readSkill(dirname(folder), basename(folder));
      if (skill) found.push({ skill, source: folder });
    } else {
      for (const skill of yield* scanSkills(folder)) found.push({ skill, source: join(folder, skill.name) });
    }

    const skills: Candidate[] = [];
    for (const { skill: scanned, source } of found) {
      const { linkedFrom: _, ...skill } = scanned;
      if (skill.error) {
        skills.push({ skill, source, state: "broken", reason: skill.error });
        continue;
      }
      const entry = join(library, skill.name);
      const there = yield* Effect.result(fs.lstat(entry));
      if (there._tag === "Failure") {
        skills.push({ skill, source, state: "new" });
        continue;
      }
      const target = yield* real(entry);
      const same = target !== undefined && target === (yield* real(source));
      skills.push(
        same
          ? { skill, source, state: "added" }
          : { skill, source, state: "taken", reason: `The library already has something named ${skill.name} (${entry}), which stays as it is.` },
      );
    }
    return { folder, skills };
  });

export type Skills = {
  readonly view: () => SkillsView;
  readonly rescan: Effect.Effect<void>;
  readonly enable: (bot: BotRow, names: readonly string[], on: boolean) => Effect.Effect<void, SkillError>;
  readonly preview: (folder: string) => Effect.Effect<SkillFolder, SkillError>;
  readonly addFolder: (folder: string, bots: readonly BotRow[]) => Effect.Effect<SkillFolderAdded, SkillError>;
  readonly section: (bot: BotRow) => Effect.Effect<string | null>;
  readonly note: (bot: BotRow, text: string) => Effect.Effect<UserText | undefined>;
};

export const makeSkills = Effect.fnUntraced(function* (config: SkillsConfig, announce: (view: SkillsView) => Effect.Effect<void>) {
  const store = yield* Store;
  const fs = yield* FileSystem.FileSystem;
  yield* Effect.ignore(fs.makeDirectory(config.library, { recursive: true }));
  const provide = Effect.provideService(FileSystem.FileSystem, fs);
  let current: SkillsView = { library: config.library, shared: [], bots: [] };
  const lock = yield* Semaphore.make(1);

  const botSkills = (bot: BotRow, enabled: readonly string[]): Effect.Effect<BotSkills> =>
    Effect.map(provide(scanSkills(config.local(bot))), (local) => ({ bot: bot.id, folder: config.local(bot), local, enabled }));

  const viewOf = (bot: BotRow) =>
    Effect.gen(function* () {
      const enabled = (yield* store.enabledSkills).get(bot.id) ?? [];
      const shared = yield* provide(scanSkills(config.library));
      return { library: config.library, shared, bots: [yield* botSkills(bot, enabled)] } satisfies SkillsView;
    });

  const scan = Effect.gen(function* () {
    const enabled = yield* store.enabledSkills;
    const shared = yield* provide(scanSkills(config.library));
    const bots: BotSkills[] = [];
    for (const bot of yield* store.bots) bots.push(yield* botSkills(bot, enabled.get(bot.id) ?? []));
    const next: SkillsView = { library: config.library, shared, bots };
    if (JSON.stringify(next) === JSON.stringify(current)) return;
    current = next;
    yield* announce(next);
  });
  const rescan = lock.withPermits(1)(scan);
  yield* rescan;

  const preview = (folder: string) =>
    Effect.map(provide(inspectSkillFolder(config.library, folder)), ({ folder, skills }) => ({
      folder,
      skills: skills.map(({ source: _, ...entry }) => entry),
    }));

  const addFolder = (folder: string, bots: readonly BotRow[]) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const inspected = yield* provide(inspectSkillFolder(config.library, folder));
        const added: string[] = [];
        const usable: string[] = [];
        const skipped: { name: string; reason: string }[] = [];
        for (const entry of inspected.skills) {
          const name = entry.skill.name;
          if (entry.state === "added") usable.push(name);
          else if (entry.state !== "new") skipped.push({ name, reason: entry.reason ?? "It can't be added." });
          else {
            // A link is made only where nothing is: if something took the name since the folder was read, it stays.
            const linked = yield* Effect.result(fs.symlink(entry.source, join(config.library, name)));
            if (linked._tag === "Failure") skipped.push({ name, reason: `It couldn't be linked into the library: ${messageOf(linked.failure)}` });
            else {
              added.push(name);
              usable.push(name);
            }
          }
        }
        const enabled: { bot: BotRow["id"]; names: string[] }[] = [];
        for (const bot of bots) {
          const own = new Set((yield* provide(scanSkills(config.local(bot)))).map((s) => s.name));
          const names = usable.filter((name) => !own.has(name));
          for (const name of usable.filter((name) => own.has(name)))
            skipped.push({ name, reason: `${bot.name} has its own ${name}, which it keeps using: switch that one on under its own skills.` });
          yield* store.enableSkills(bot.id, names, true);
          enabled.push({ bot: bot.id, names });
        }
        yield* scan;
        return { folder: inspected.folder, added, enabled, skipped } satisfies SkillFolderAdded;
      }),
    );

  return {
    view: () => current,
    rescan,
    preview,
    addFolder,
    enable: (bot, names, on) =>
      Effect.gen(function* () {
        const unique = [...new Set(names)];
        if (on) {
          const view = yield* viewOf(bot);
          for (const name of unique) {
            const local = view.bots[0]!.local.find((s) => s.name === name);
            const found = local ?? view.shared.find((s) => s.name === name);
            if (!found) return yield* new SkillError({ message: `${bot.name} has no skill named ${name}. Rescan if it was just added.` });
            if (found.error) return yield* new SkillError({ message: `${name} can't be used: ${found.error}` });
          }
        }
        yield* store.enableSkills(bot.id, unique, on);
        yield* rescan;
      }),
    section: (bot) => Effect.map(viewOf(bot), (view) => skillsSection(activeSkills(view, bot.id), { library: config.library, local: config.local(bot) })),
    note: (bot, text) =>
      Effect.gen(function* () {
        const name = skillInvocation(text);
        if (!name) return undefined;
        const skill = activeSkills(yield* viewOf(bot), bot.id).find((s) => s.name === name);
        return skill ? yield* provide(invocationNote(skill)) : undefined;
      }),
  } satisfies Skills;
});
