import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { activeSkills, type SkillsView, skillInvocation } from "@top/protocol";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import { afterAll, test } from "vitest";
import { toWire } from "../src/wire.ts";
import { type Harness, harness, idle, skillsConfig, until } from "./harness.ts";

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function writeSkill(root: string, folder: string, frontmatter: string | undefined, body = "Follow these steps.") {
  mkdirSync(join(root, folder), { recursive: true });
  writeFileSync(join(root, folder, "SKILL.md"), frontmatter === undefined ? body : `---\n${frontmatter}\n---\n${body}\n`);
}
const meta = (name: string, description: string) => `name: ${name}\ndescription: ${description}`;

let requests = 0;
async function send(h: Harness, bot: number, text: string) {
  await h.run(h.daemon.submit(bot, `skills-${++requests}`, text, "followUp", null));
  await until("the bot to finish", () => idle(h, bot), 10_000);
}
const prompt = async (h: Harness, bot: number) => getCurrentSystemPrompt(await h.run(h.store.context(bot)));
const view = (h: Harness): SkillsView => h.daemon.skills!.view();
const rescan = (h: Harness) => h.run(h.daemon.skills!.rescan);
const enable = async (h: Harness, bot: number, name: string, on = true) => h.run(h.daemon.skills!.enable((await h.run(h.store.bot(bot)))!, [name], on));
const refusal = async (h: Harness, bot: number, name: string) => {
  const exit = await h.run(Effect.flip(h.daemon.skills!.enable((await h.run(h.store.bot(bot)))!, [name], true)));
  return `${exit._tag}: ${exit.message}`;
};

async function setup(fill: (where: { library: string; atlas: string; scout: string }) => void = () => {}, dir?: string) {
  const home = dir ?? mkdtempSync(join(tmpdir(), "top-skills-"));
  if (!dir) scratch.push(home);
  const config = skillsConfig(home);
  fill({ library: config.library, atlas: config.local({ name: "Atlas" }), scout: config.local({ name: "Scout" }) });
  const h = await harness({ dir: home, bots: ["Atlas", "Scout"], skills: true });
  const [atlas, scout] = h.bots as [number, number];
  return { h, home, atlas, scout, library: config.library, local: config.local };
}

test("skillInvocation reads /<name> only at the very start, as a whole word", () => {
  assert.equal(skillInvocation("/pdf"), "pdf");
  assert.equal(skillInvocation("/pdf summarize this"), "pdf");
  assert.equal(skillInvocation("/web-research\nfind it"), "web-research");
  assert.equal(skillInvocation(" /pdf"), undefined);
  assert.equal(skillInvocation("use /pdf"), undefined);
  assert.equal(skillInvocation("/usr/bin is broken"), undefined);
  assert.equal(skillInvocation("/PDF"), undefined);
  assert.equal(skillInvocation("/a--b"), undefined);
  assert.equal(skillInvocation(`/${"a".repeat(65)}`), undefined);
});

test("the library is read as it is: bad skills say why, and don't keep the good ones out", async () => {
  const { h, library } = await setup(({ library }) => {
    writeSkill(library, "pdf", meta("pdf", "Fill in and read PDF forms."));
    writeSkill(library, "Bad_Name", meta("Bad_Name", "Uppercase isn't a skill name."));
    writeSkill(library, "no-description", "name: no-description");
    writeSkill(library, "mismatch", meta("other", "Its name isn't its folder's."));
    writeSkill(library, "no-frontmatter", undefined, "# Just text");
    writeSkill(library, "broken-yaml", "name: broken-yaml\ndescription: [unclosed");
    mkdirSync(join(library, "empty"), { recursive: true });
    writeSkill(library, ".hidden", meta("hidden", "Hidden folders are skipped."));
    writeFileSync(join(library, "README.md"), "Not a skill.");
    const elsewhere = mkdtempSync(join(tmpdir(), "top-skill-elsewhere-"));
    scratch.push(elsewhere);
    writeSkill(elsewhere, "linked", meta("linked", "Kept in another folder."));
    symlinkSync(join(elsewhere, "linked"), join(library, "linked"));
    symlinkSync(join(elsewhere, "gone"), join(library, "dangling"));
  });
  const shared = view(h).shared;
  assert.equal(view(h).library, library);
  assert.deepEqual(
    shared.map((s) => s.name),
    ["Bad_Name", "broken-yaml", "dangling", "empty", "linked", "mismatch", "no-description", "no-frontmatter", "pdf"],
  );
  const by = (name: string) => shared.find((s) => s.name === name)!;
  assert.deepEqual(by("pdf"), { name: "pdf", description: "Fill in and read PDF forms.", path: join(library, "pdf", "SKILL.md") });
  assert.deepEqual(by("linked"), {
    name: "linked",
    description: "Kept in another folder.",
    path: join(library, "linked", "SKILL.md"),
    linkedFrom: dirname(readlinkSync(join(library, "linked"))),
  });
  assert.match(by("Bad_Name").error!, /lowercase letters, digits and single hyphens/);
  assert.match(by("no-description").error!, /no description/);
  assert.match(by("mismatch").error!, /isn't its folder's name/);
  assert.match(by("no-frontmatter").error!, /no frontmatter/);
  assert.match(by("broken-yaml").error!, /isn't valid YAML/);
  assert.match(by("empty").error!, /no SKILL.md/);
  assert.match(by("dangling").error!, /link to .*gone, which isn't there/);
});

test("a bot starts with no skills, however many are installed, and gets only the ones switched on for it", async () => {
  const { h, atlas, scout, library, local } = await setup(({ library, atlas }) => {
    writeSkill(library, "pdf", meta("pdf", "Fill in and read PDF forms."));
    writeSkill(library, "deploy", meta("deploy", "Ship the web app."));
    writeSkill(atlas, "notes", meta("notes", "Keep Atlas's notes tidy."));
  });
  assert.deepEqual(
    view(h).bots.map((b) => [b.bot, b.local.map((s) => s.name), b.enabled]),
    [
      [atlas, ["notes"], []],
      [scout, [], []],
    ],
  );
  await send(h, atlas, "hello");
  assert.doesNotMatch(await prompt(h, atlas), /<skills>/);
  const fresh = await h.run(h.daemon.createBot("Nova", ""));
  assert.deepEqual(view(h).bots.find((b) => b.bot === fresh)?.enabled, []);

  await enable(h, atlas, "pdf");
  await enable(h, atlas, "notes");
  assert.deepEqual(view(h).bots.find((b) => b.bot === atlas)?.enabled, ["notes", "pdf"]);
  await send(h, atlas, "hello again");
  const atlasPrompt = await prompt(h, atlas);
  assert.match(atlasPrompt, /<skills>/);
  assert.match(atlasPrompt, new RegExp(`<location>${join(library, "pdf", "SKILL.md")}</location>`));
  assert.match(atlasPrompt, new RegExp(`<location>${join(local({ name: "Atlas" }), "notes", "SKILL.md")}</location>`));
  assert.match(atlasPrompt, /<description>Fill in and read PDF forms.<\/description>\n {4}<source>shared<\/source>/);
  assert.match(atlasPrompt, /<description>Keep Atlas's notes tidy.<\/description>\n {4}<source>yours<\/source>/);
  assert.match(atlasPrompt, /relative to its folder, the one holding SKILL.md, not to your working folder/);
  assert.match(atlasPrompt, /changing a shared skill changes it for all of them/);
  assert.doesNotMatch(atlasPrompt, /deploy/);
  await send(h, scout, "hello");
  assert.doesNotMatch(await prompt(h, scout), /<skills>/);

  await enable(h, atlas, "pdf", false);
  await enable(h, atlas, "notes", false);
  await send(h, atlas, "and again");
  assert.doesNotMatch(await prompt(h, atlas), /<skills>/);
});

test("switching on needs a usable skill the bot can see; switching off takes any name", async () => {
  const { h, atlas, scout } = await setup(({ library, atlas }) => {
    writeSkill(library, "broken", "name: broken");
    writeSkill(atlas, "notes", meta("notes", "Atlas's own."));
  });
  assert.match(await refusal(h, atlas, "nothing"), /SkillError: Atlas has no skill named nothing/);
  assert.match(await refusal(h, atlas, "broken"), /SkillError: broken can't be used: .*no description/);
  assert.match(await refusal(h, scout, "notes"), /SkillError: Scout has no skill named notes/);
  await enable(h, scout, "nothing", false);
  assert.deepEqual(view(h).bots.find((b) => b.bot === scout)?.enabled, []);
});

test("a bot's own skill takes the place of a shared one with its name, for that bot only, and says so", async () => {
  const { h, atlas, scout, library, local } = await setup(({ library, atlas }) => {
    writeSkill(library, "pdf", meta("pdf", "The shared PDF skill."));
    writeSkill(atlas, "pdf", meta("pdf", "Atlas's own PDF skill."));
  });
  await enable(h, atlas, "pdf");
  await enable(h, scout, "pdf");
  const atlasActive = activeSkills(view(h), atlas);
  assert.deepEqual(atlasActive, [
    { name: "pdf", description: "Atlas's own PDF skill.", path: join(local({ name: "Atlas" }), "pdf", "SKILL.md"), source: "local" },
  ]);
  assert.deepEqual(activeSkills(view(h), scout), [
    { name: "pdf", description: "The shared PDF skill.", path: join(library, "pdf", "SKILL.md"), source: "shared" },
  ]);
  await send(h, atlas, "hi");
  await send(h, scout, "hi");
  const atlasPrompt = await prompt(h, atlas);
  assert.match(atlasPrompt, /Atlas's own PDF skill/);
  assert.doesNotMatch(atlasPrompt, /The shared PDF skill/);
  assert.match(await prompt(h, scout), /The shared PDF skill/);

  writeSkill(local({ name: "Atlas" }), "pdf", "name: pdf");
  await rescan(h);
  assert.match(activeSkills(view(h), atlas)[0]!.error!, /no description/);
  await send(h, atlas, "hi again");
  assert.doesNotMatch(await prompt(h, atlas), /<skills>/);
});

test("/<name> brings the skill's SKILL.md with the message, with its folder for relative paths", async () => {
  const { h, atlas, library } = await setup(({ library }) => {
    writeSkill(library, "pdf", meta("pdf", "Fill in PDF forms."), "Run scripts/fill.py with the form's path.");
    writeSkill(library, "other", meta("other", "Not switched on."));
  });
  await enable(h, atlas, "pdf");
  await send(h, atlas, "/pdf fill in tax.pdf");
  const entries = await h.entries(atlas);
  const stored = entries.findLast((e) => e.kind === "user")!;
  assert.equal(stored.kind, "user");
  const parts = typeof stored.message.content === "string" ? [] : stored.message.content;
  const note = parts.find((p) => p.type === "text" && p.skill);
  assert.ok(note && note.type === "text");
  const path = join(library, "pdf", "SKILL.md");
  assert.deepEqual(note.skill, { name: "pdf", source: "shared", path });
  assert.match(note.text, new RegExp(`Paths in it are relative to ${join(library, "pdf")}`));
  assert.match(note.text, /every bot that has it uses these same files/);
  assert.match(note.text, /Run scripts\/fill.py with the form's path./);
  const wire = toWire(stored);
  assert.ok(wire?.kind === "user");
  assert.equal(wire.text, "/pdf fill in tax.pdf");
  assert.deepEqual(wire.skill, { name: "pdf", source: "shared", path });

  await send(h, atlas, "/other please");
  const plain = (await h.entries(atlas)).findLast((e) => e.kind === "user")!;
  assert.equal(plain.kind === "user" && plain.message.content, "/other please");

  writeFileSync(path, "no frontmatter now");
  await send(h, atlas, "/pdf again");
  const failed = toWire((await h.entries(atlas)).findLast((e) => e.kind === "user")!);
  assert.ok(failed?.kind === "user");
  assert.match(failed.skill?.error ?? "", /no frontmatter/);
});

test("which skills a bot has survives a restart; edits on disk reach it with its next message", async () => {
  const first = await setup(({ library }) => writeSkill(library, "pdf", meta("pdf", "Version one.")));
  await enable(first.h, first.atlas, "pdf");
  await send(first.h, first.atlas, "hi");
  assert.match(await prompt(first.h, first.atlas), /Version one/);
  await first.h.close();

  const again = await setup(() => {}, first.home);
  assert.deepEqual(view(again.h).bots.find((b) => b.bot === first.atlas)?.enabled, ["pdf"]);
  const systemCount = async () => (await again.h.run(again.h.store.context(first.atlas))).filter((m) => m.role === "system").length;
  const before = await systemCount();
  await send(again.h, first.atlas, "back");
  assert.equal(await systemCount(), before);

  const announced = await again.h.run(
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const { subscription } = yield* again.h.events.subscribe.pipe(Scope.provide(scope));
      writeSkill(first.library, "pdf", meta("pdf", "Version two."));
      yield* again.h.daemon.skills!.rescan;
      const events: string[] = [];
      while ((yield* PubSub.remaining(subscription)) > 0) events.push((yield* PubSub.take(subscription))._tag);
      yield* Scope.close(scope, Effect.void as never);
      return events;
    }),
  );
  assert.deepEqual(announced, ["Skills"]);
  assert.equal(view(again.h).shared[0]?.description, "Version two.");
  await send(again.h, first.atlas, "anything new?");
  const updated = await prompt(again.h, first.atlas);
  assert.match(updated, /Version two/);
  assert.doesNotMatch(updated, /Version one/);
});

test("a deleted bot's skills go with it, and its folder's skills leave the view", async () => {
  const { h, atlas, scout } = await setup(({ library }) => writeSkill(library, "pdf", meta("pdf", "PDFs.")));
  await enable(h, atlas, "pdf");
  await enable(h, scout, "pdf");
  await h.run(h.daemon.deleteBot(atlas));
  assert.deepEqual(
    view(h).bots.map((b) => b.bot),
    [scout],
  );
  await until("the bot to be purged", async () => !(await h.run(h.store.bot(atlas))));
  assert.deepEqual([...(await h.run(h.store.enabledSkills))], [[scout, ["pdf"]]]);
});

test("disable-model-invocation keeps a skill out of the bot's instructions, and /<name> still brings it", async () => {
  const { h, atlas, library } = await setup(({ library }) => {
    writeSkill(library, "pdf", meta("pdf", "Fill in PDF forms."));
    writeSkill(library, "release", `${meta("release", "Cut a release.")}\ndisable-model-invocation: true`, "Tag it, then publish.");
    writeSkill(library, "quoted", `${meta("quoted", "Quoted true.")}\ndisable-model-invocation: "true"`);
    writeSkill(library, "allowed", `${meta("allowed", "Explicitly allowed.")}\ndisable-model-invocation: false`);
    writeSkill(library, "unclear", `${meta("unclear", "Not a boolean.")}\ndisable-model-invocation: sometimes`);
  });
  const by = (name: string) => view(h).shared.find((s) => s.name === name)!;
  assert.deepEqual(by("release"), { name: "release", description: "Cut a release.", path: join(library, "release", "SKILL.md"), manual: true });
  assert.equal(by("quoted").manual, true);
  assert.equal(by("allowed").manual, undefined);
  assert.equal(by("pdf").manual, undefined);
  assert.match(by("unclear").error!, /disable-model-invocation is "sometimes", which isn't true or false/);
  assert.equal(by("unclear").manual, undefined);
  assert.match(await refusal(h, atlas, "unclear"), /can't be used/);

  await enable(h, atlas, "release");
  await send(h, atlas, "hello");
  assert.doesNotMatch(await prompt(h, atlas), /<skills>/, "a bot with only manual skills isn't told about skills at all");

  await enable(h, atlas, "pdf");
  await enable(h, atlas, "allowed");
  await send(h, atlas, "hello again");
  const listed = await prompt(h, atlas);
  assert.match(listed, /<name>pdf<\/name>/);
  assert.match(listed, /<name>allowed<\/name>/);
  assert.doesNotMatch(listed, /release/);
  assert.deepEqual(
    activeSkills(view(h), atlas).map((s) => s.name),
    ["allowed", "pdf", "release"],
    "the composer's / menu still offers it",
  );

  await send(h, atlas, "/release v2");
  const stored = (await h.entries(atlas)).findLast((e) => e.kind === "user")!;
  const parts = stored.kind === "user" && typeof stored.message.content !== "string" ? stored.message.content : [];
  const note = parts.find((p) => p.type === "text" && p.skill);
  assert.ok(note && note.type === "text");
  assert.deepEqual(note.skill, { name: "release", source: "shared", path: join(library, "release", "SKILL.md") });
  assert.match(note.text, /Tag it, then publish\./);
  assert.match(note.text, /disable-model-invocation: true/, "SKILL.md goes as it is, frontmatter included");
});

test("switching several on is all or nothing", async () => {
  const { h, atlas } = await setup(({ library }) => {
    writeSkill(library, "pdf", meta("pdf", "PDFs."));
    writeSkill(library, "deploy", meta("deploy", "Deploys."));
    writeSkill(library, "broken", "name: broken");
  });
  const enableMany = async (names: string[], on: boolean) => h.run(Effect.result(h.daemon.skills!.enable((await h.run(h.store.bot(atlas)))!, names, on)));
  const refused = await enableMany(["pdf", "deploy", "broken"], true);
  assert.equal(refused._tag, "Failure");
  assert.deepEqual(view(h).bots.find((b) => b.bot === atlas)?.enabled, []);
  assert.equal((await enableMany(["pdf", "deploy", "pdf"], true))._tag, "Success");
  assert.deepEqual(view(h).bots.find((b) => b.bot === atlas)?.enabled, ["deploy", "pdf"]);
  assert.equal((await enableMany(["pdf", "deploy", "gone"], false))._tag, "Success");
  assert.deepEqual(view(h).bots.find((b) => b.bot === atlas)?.enabled, []);
});

function collection() {
  const root = mkdtempSync(join(tmpdir(), "top-skill-pack-"));
  scratch.push(root);
  const skills = join(root, "skills");
  writeSkill(skills, "plan", `${meta("plan", "Plan the work.")}\ndisable-model-invocation: true`, "Write the plan. See ../review/SKILL.md.");
  writeSkill(skills, "review", meta("review", "Review a change."));
  writeSkill(skills, "pdf", meta("pdf", "The collection's PDF skill."));
  writeSkill(skills, "notes", meta("notes", "The collection's notes."));
  writeSkill(skills, "Bad_Name", meta("Bad_Name", "Not a skill name."));
  writeSkill(skills, "no-description", "name: no-description");
  writeFileSync(join(skills, "install.sh"), "#!/bin/sh\ntouch ran\n");
  writeSkill(skills, ".git", meta("git", "Hidden."));
  return skills;
}

test("adding a folder of skills links each new one into the library, replaces nothing, and switches them on for chosen bots", async () => {
  const skills = collection();
  const { h, atlas, scout, library } = await setup(({ library, atlas }) => {
    writeSkill(library, "pdf", meta("pdf", "The library's own PDF skill."));
    writeSkill(atlas, "notes", meta("notes", "Atlas's own notes."));
  });
  const fs = await import("node:fs");
  const libraryPdf = fs.readFileSync(join(library, "pdf", "SKILL.md"), "utf8");

  const preview = await h.run(h.daemon.skills!.preview(`${skills}/`));
  assert.equal(preview.folder, skills);
  assert.deepEqual(
    preview.skills.map((s) => [s.skill.name, s.state, s.skill.manual ?? false]),
    [
      ["Bad_Name", "broken", false],
      ["no-description", "broken", false],
      ["notes", "new", false],
      ["pdf", "taken", false],
      ["plan", "new", true],
      ["review", "new", false],
    ],
  );
  assert.match(preview.skills.find((s) => s.skill.name === "pdf")!.reason!, /already has something named pdf .*stays as it is/);
  assert.equal(preview.skills.find((s) => s.skill.name === "plan")!.skill.path, join(skills, "plan", "SKILL.md"));
  assert.deepEqual(fs.readdirSync(library), ["pdf"], "a preview changes nothing");

  const added = await h.run(h.daemon.skills!.addFolder(skills, [(await h.run(h.store.bot(atlas)))!]));
  assert.deepEqual(added.added, ["notes", "plan", "review"]);
  assert.deepEqual(added.enabled, [{ bot: atlas, names: ["plan", "review"] }]);
  assert.deepEqual(
    added.skipped.map((s) => s.name),
    ["Bad_Name", "no-description", "pdf", "notes"],
  );
  assert.match(added.skipped.at(-1)!.reason, /Atlas has its own notes, which it keeps using/);

  for (const name of ["notes", "plan", "review"]) {
    assert.ok(fs.lstatSync(join(library, name)).isSymbolicLink());
    assert.equal(fs.readlinkSync(join(library, name)), join(skills, name));
  }
  assert.equal(fs.readFileSync(join(library, "pdf", "SKILL.md"), "utf8"), libraryPdf, "the skill already there is untouched");
  assert.ok(!fs.existsSync(join(library, "Bad_Name")) && !fs.existsSync(join(library, "no-description")) && !fs.existsSync(join(library, "git")));
  assert.ok(!fs.existsSync(join(skills, "ran")) && !fs.existsSync(join(library, "ran")), "nothing in the folder is run");

  const shared = view(h).shared;
  assert.deepEqual(
    shared.map((s) => [s.name, s.linkedFrom]),
    [
      ["notes", skills],
      ["pdf", undefined],
      ["plan", skills],
      ["review", skills],
    ],
  );
  assert.deepEqual(view(h).bots.find((b) => b.bot === atlas)?.enabled, ["plan", "review"]);
  assert.deepEqual(view(h).bots.find((b) => b.bot === scout)?.enabled, []);
  assert.equal(
    activeSkills(view(h), atlas).find((s) => s.name === "notes"),
    undefined,
  );

  await send(h, atlas, "hello");
  const listed = await prompt(h, atlas);
  assert.match(listed, /<name>review<\/name>/);
  assert.doesNotMatch(listed, /<name>plan<\/name>/);
  await send(h, atlas, "/plan the launch");
  const stored = (await h.entries(atlas)).findLast((e) => e.kind === "user")!;
  const note =
    stored.kind === "user" && typeof stored.message.content !== "string" ? stored.message.content.find((p) => p.type === "text" && p.skill) : undefined;
  assert.ok(note?.type === "text");
  assert.match(note.text, /Write the plan\. See \.\.\/review\/SKILL\.md\./, "the upstream text, unchanged");

  const again = await h.run(h.daemon.skills!.preview(skills));
  assert.deepEqual(
    again.skills.filter((s) => s.state === "added").map((s) => s.skill.name),
    ["notes", "plan", "review"],
  );
  const scoutToo = await h.run(h.daemon.skills!.addFolder(skills, [(await h.run(h.store.bot(scout)))!]));
  assert.deepEqual(scoutToo.added, []);
  assert.deepEqual(scoutToo.enabled, [{ bot: scout, names: ["notes", "plan", "review"] }]);
  assert.deepEqual(view(h).bots.find((b) => b.bot === scout)?.enabled, ["notes", "plan", "review"]);
});

test("a folder that is one skill is added as that skill; other folders are refused with a reason", async () => {
  const skills = collection();
  const { h, library } = await setup();
  const fs = await import("node:fs");
  const one = await h.run(h.daemon.skills!.addFolder(join(skills, "review"), []));
  assert.deepEqual(one.added, ["review"]);
  assert.equal(fs.readlinkSync(join(library, "review")), join(skills, "review"));

  const refused = async (folder: string) => {
    const exit = await h.run(Effect.flip(h.daemon.skills!.preview(folder)));
    return `${exit._tag}: ${exit.message}`;
  };
  assert.match(await refused(""), /SkillError: Give the path/);
  assert.match(await refused("skills"), /SkillError: Give the folder's full path/);
  assert.match(await refused(join(skills, "missing")), /SkillError: There's no folder at/);
  assert.match(await refused(join(skills, "install.sh")), /SkillError: .*install\.sh isn't a folder/);
  assert.match(await refused(library), /SkillError: .* is in the shared library already/);
  assert.match(await refused(join(library, "review")), /SkillError: .* is in the shared library already/);
  const empty = join(skills, "..", "empty");
  mkdirSync(empty);
  assert.deepEqual(await h.run(h.daemon.skills!.preview(empty)), { folder: join(skills, "..", "empty"), skills: [] });

  fs.rmSync(join(library, "review"));
  fs.symlinkSync(join(skills, "elsewhere"), join(library, "review"));
  const dangling = await h.run(h.daemon.skills!.preview(skills));
  assert.equal(dangling.skills.find((s) => s.skill.name === "review")?.state, "taken", "a dangling link with the name is still not replaced");
  const kept = await h.run(h.daemon.skills!.addFolder(skills, []));
  assert.ok(!kept.added.includes("review"));
  assert.equal(fs.readlinkSync(join(library, "review")), join(skills, "elsewhere"));
});
