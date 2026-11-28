import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_CONTEXT_FILE_BYTES } from "@top/protocol";
import { test } from "vitest";
import { fakeClaude } from "../src/fakeClaude.ts";
import { textOf } from "../src/messages.ts";
import { toWire } from "../src/wire.ts";
import { botFolder } from "../src/workspace.ts";
import { type Harness, harness, idle, until } from "./harness.ts";

const TOOL = "collar__create_bot";
const MESSAGE = "collar__message_bot";

let n = 0;
const submit = (h: Harness, bot: number, message: string) => h.run(h.daemon.submit(bot, `create-${++n}`, message, "followUp", null));

/** Runs the tool as a bot's call with this key would, the way a replay after a restart does too. */
async function call(h: Harness, bot: number, args: Record<string, unknown>, key = `c${++n}`) {
  const tool = h.daemon.toolsOf(bot).find((t) => t.name === TOOL)!;
  const result = await h.run(tool.run(args, { key, bot }));
  return { text: (result.content[0] as { text: string }).text, isError: result.isError === true, details: result.details };
}

const named = (h: Harness, name: string) => h.daemon.bots().find((b) => b.name === name);
const folderOf = (h: Harness, name: string) => botFolder(join(h.dir, "bots"), name);
const settled = async (h: Harness) => {
  for (const bot of h.daemon.bots()) if (!(await idle(h, bot.id))) return false;
  return true;
};
const userTexts = async (h: Harness, bot: number) => (await h.entries(bot)).flatMap((e) => (e.kind === "user" ? [textOf(e.message.content)] : []));
/** As if the user wrote to the bot (and it read it). */

test("a bot makes a teammate with one call: it's in the sidebar at once, with its SOUL.md and AGENTS.md, then takes work by message", async () => {
  const h = await harness({ bots: ["Atlas", "Bolt"], gatherMs: 0, context: true });
  const [atlas, bolt] = h.bots as [number, number];
  await h.run(h.daemon.start);
  const args = { name: "Nova", purpose: "Reviews pull requests.", soul: "## Voice\nTerse.", agents: "Always cite file:line." };
  await submit(h, atlas, `call ${TOOL} ${JSON.stringify(args)}`);
  await until("Nova to be made", async () => (await settled(h)) && named(h, "Nova"), 10_000);

  const nova = named(h, "Nova")!;
  assert.equal(nova.description, "Reviews pull requests.");
  assert.equal(readFileSync(join(folderOf(h, "Nova"), "SOUL.md"), "utf8"), "# Nova\n\nReviews pull requests.\n\n## Voice\nTerse.\n");
  assert.equal(readFileSync(join(folderOf(h, "Nova"), "AGENTS.md"), "utf8"), "Always cite file:line.\n");
  const row = await h.run(h.store.bot(nova.id));
  assert.equal(row?.createdBy, atlas);
  assert.equal(row?.createdByName, "Atlas");
  assert.equal((await h.run(h.store.bot(atlas)))?.createdBy, null, "a bot the user made has no maker");
  // Its own conversation says who made it; that line isn't something the model reads.
  assert.deepEqual(
    (await h.entries(nova.id)).filter((e) => e.kind === "notice").map((e) => (e.kind === "notice" ? e.message.text : "")),
    ["Created by Atlas"],
  );
  assert.deepEqual(await h.run(h.store.context(nova.id)).then((c) => c.filter((m) => m.role !== "system")), []);

  // The receipt: the bot's id and name at once, and a card for the apps.
  const tool = (await h.entries(atlas)).find((e) => e.kind === "tool");
  assert.ok(tool?.kind === "tool");
  assert.match(textOf(tool.message.content), new RegExp(`^Created Nova \\(bot ${nova.id}\\)\\.`));
  const wire = toWire(tool);
  assert.ok(wire?.kind === "tool");
  assert.deepEqual(wire.createdBot, { id: nova.id, name: "Nova", purpose: "Reviews pull requests." });

  // Everyone's roster has it from their next turn.
  await submit(h, bolt, "hello");
  await until("Bolt to answer", async () => (await settled(h)) && (await h.entries(bolt)).at(-1)?.kind === "assistant");
  assert.match((await h.run(h.daemon.runner(bolt))).systemPrompt()?.sections?.bots ?? "", /\n- Nova: Reviews pull requests\.\n/);

  // The maker gives it work with message_bot, and Nova's reply comes back.
  const reply = JSON.stringify({ reply_to: 1, text: "on it" });
  await submit(h, atlas, `call ${MESSAGE} ${JSON.stringify({ to: "Nova", text: `call ${MESSAGE} ${reply}` })}`);
  await until("Nova's reply to reach Atlas", async () => (await settled(h)) && (await userTexts(h, atlas)).some((t) => t.endsWith("\non it")), 10_000);
  assert.match((await h.run(h.daemon.runner(nova.id))).systemPrompt()?.sections?.bots ?? "", /\n- Atlas\n- Bolt\n/);
});

test("what the daemon won't make is refused to the bot with why, and nothing is made", async () => {
  const h = await harness({ bots: ["Atlas", "Bolt"], gatherMs: 60_000, context: true });
  const [atlas] = h.bots as [number, number];
  const refused = async (args: Record<string, unknown>, why: RegExp) => {
    const result = await call(h, atlas, args);
    assert.equal(result.isError, true, result.text);
    assert.match(result.text, why);
  };
  await refused({ name: "bolt", purpose: "Twin." }, /^Not created: There's already a bot named bolt\.$/);
  await refused({ name: "  ", purpose: "Nameless." }, /^Not created: Give the bot a name\.$/);
  await refused({ name: "Nova", purpose: " " }, /^Not created: say what it's for/);
  await refused({ name: "Nova", purpose: "Reviews.", model: "claude/sonnet" }, /^Not created: This daemon doesn't run bots on Claude Code\.$/);
  await refused({ name: "Nova", purpose: "Reviews.", model: "openai/gpt-4o" }, /^Not created: Bots here run on /);
  await refused({ name: "Nova", purpose: "Reviews.", soul: "x".repeat(MAX_CONTEXT_FILE_BYTES) }, /^Not created: Keep SOUL\.md under 8 KB/);
  await refused({ name: "Nova", purpose: "Reviews.", agents: "x".repeat(MAX_CONTEXT_FILE_BYTES + 1) }, /^Not created: Keep AGENTS\.md under 8 KB/);
  // An earlier bot's files in the folder its name would get.
  mkdirSync(folderOf(h, "Old"), { recursive: true });
  writeFileSync(join(folderOf(h, "Old"), "MEMORY.md"), "the old bot's notes");
  await refused({ name: "Old", purpose: "Reviews." }, /still has MEMORY\.md from an earlier bot/);
  assert.deepEqual(
    h.daemon.bots().map((b) => b.name),
    ["Atlas", "Bolt"],
  );
});

test("a call run again, before or after a restart, finds the bot it made and makes none", async () => {
  const dir = mkdtempSync(join(tmpdir(), "top-create-"));
  const first = await harness({ dir, bots: ["Atlas"], gatherMs: 60_000, context: true });
  const atlas = first.bot;
  const args = { name: "Nova", purpose: "Reviews pull requests." };
  const made = await call(first, atlas, args, "1:4:call_a");
  const again = await call(first, atlas, args, "1:4:call_a");
  assert.equal(made.isError, false, made.text);
  assert.deepEqual(again, made);
  await first.close();

  const h = await harness({ dir, bots: ["Atlas"], gatherMs: 60_000, context: true });
  const replayed = await call(h, atlas, args, "1:4:call_a");
  assert.deepEqual(replayed, made, "the same receipt, not 'already a bot named Nova'");
  assert.equal(h.daemon.bots().filter((b) => b.name === "Nova").length, 1);
});

test("a creation a restart cut off after the files were written is finished by the same call run again; no other call takes the files", async () => {
  const h = await harness({ bots: ["Atlas"], gatherMs: 60_000, context: true });
  // What the call had done before the daemon died: recorded itself and written the files, not saved the bot.
  await h.run(h.store.reserveCreation("1:4:call_a", h.bot, folderOf(h, "Nova")));
  mkdirSync(folderOf(h, "Nova"), { recursive: true });
  writeFileSync(join(folderOf(h, "Nova"), "SOUL.md"), "# Nova\n\nReviews.\n");
  const other = await call(h, h.bot, { name: "Nova", purpose: "Reviews.", agents: "Cite lines." }, "1:9:call_b");
  assert.equal(other.isError, true, "another call with the same name and purpose doesn't adopt them");
  assert.match(other.text, /still has SOUL\.md from an earlier bot/);
  const done = await call(h, h.bot, { name: "Nova", purpose: "Reviews.", agents: "Cite lines." }, "1:4:call_a");
  assert.equal(done.isError, false, done.text);
  assert.equal(readFileSync(join(folderOf(h, "Nova"), "AGENTS.md"), "utf8"), "Cite lines.\n");
});

test("a call that reserved a folder and stopped before writing can't adopt what a later call wrote there", async () => {
  const h = await harness({ bots: ["Atlas"], gatherMs: 60_000, context: true });
  await h.run(h.store.reserveCreation("1:4:call_a", h.bot, folderOf(h, "Nova")));
  // A later call finds the folder empty, takes it, writes the files and stops before saving the bot.
  await h.run(h.store.reserveCreation("1:9:call_b", h.bot, folderOf(h, "Nova")));
  mkdirSync(folderOf(h, "Nova"), { recursive: true });
  writeFileSync(join(folderOf(h, "Nova"), "SOUL.md"), "# Nova\n\nReviews.\n");
  const first = await call(h, h.bot, { name: "Nova", purpose: "Reviews." }, "1:4:call_a");
  assert.equal(first.isError, true);
  assert.equal((await call(h, h.bot, { name: "Nova", purpose: "Reviews." }, "1:9:call_b")).isError, false);
});

test("a call that lost its folder to a later one and takes it back can still finish after another restart", async () => {
  const h = await harness({ bots: ["Atlas"], gatherMs: 60_000, context: true });
  await h.run(h.store.reserveCreation("1:4:call_a", h.bot, folderOf(h, "Nova")));
  await h.run(h.store.reserveCreation("1:9:call_b", h.bot, folderOf(h, "Nova")));
  // A runs again before B wrote anything: it finds the folder empty and takes it back, then writes and stops.
  await h.run(h.store.reserveCreation("1:4:call_a", h.bot, folderOf(h, "Nova")));
  assert.equal(await h.run(h.store.creationFolder("1:4:call_a")), folderOf(h, "Nova"));
  mkdirSync(folderOf(h, "Nova"), { recursive: true });
  writeFileSync(join(folderOf(h, "Nova"), "SOUL.md"), "# Nova\n\nReviews.\n");
  assert.equal((await call(h, h.bot, { name: "Nova", purpose: "Reviews." }, "1:9:call_b")).isError, true);
  assert.equal((await call(h, h.bot, { name: "Nova", purpose: "Reviews." }, "1:4:call_a")).isError, false);
});

test("running a call again after the bot it made was deleted doesn't make it again", async () => {
  const h = await harness({ bots: ["Atlas"], gatherMs: 60_000, context: true });
  await call(h, h.bot, { name: "Helper 1", purpose: "Helps." }, "make-1");
  await h.run(h.daemon.deleteBot(named(h, "Helper 1")!.id));
  const replayed = await call(h, h.bot, { name: "Helper 1", purpose: "Helps." }, "make-1");
  assert.equal(replayed.isError, false);
  assert.match(replayed.text, /deleted since/);
  assert.equal(named(h, "Helper 1"), undefined);
});

test("a bot that takes a deleted one's id isn't what a call made", async () => {
  const h = await harness({ bots: ["Atlas"], gatherMs: 60_000, context: true });
  const orion = await h.run(h.daemon.createBot("Orion", "Plans."));
  await call(h, orion, { name: "Pip", purpose: "Helps." }, "make-pip");
  const pip = named(h, "Pip")!.id;
  // Both gone and purged, the next bots made get their ids back.
  await h.run(h.daemon.deleteBot(pip));
  await h.run(h.daemon.deleteBot(orion));
  const vega = await h.run(h.daemon.createBot("Vega", "Watches."));
  const lyra = await h.run(h.daemon.createBot("Lyra", "Writes."));
  assert.deepEqual([vega, lyra], [orion, pip], "the ids were reused (else this test proves nothing)");
  assert.deepEqual(await h.run(h.store.botMadeBy("make-pip")), { id: pip, deleted: true }, "Pip's call made Pip, who's gone, not Lyra");
});

test("the purpose is kept as one plain paragraph, so the sidebar and rosters show all of it", async () => {
  const h = await harness({ bots: ["Atlas"], gatherMs: 60_000, context: true });
  const made = await call(h, h.bot, { name: "Nova", purpose: "Reviews pull requests.\n\nAnd flags risky ones." });
  assert.equal(made.isError, false, made.text);
  assert.equal(named(h, "Nova")?.description, "Reviews pull requests. And flags risky ones.");
  const heading = await call(h, h.bot, { name: "Vega", purpose: "# Vega\nReviews." });
  assert.equal(heading.isError, true);
  assert.match(heading.text, /plain sentence/);
});

test("a bot made by a bot is like any other: it can make bots too, and nothing caps how many", async () => {
  const h = await harness({ bots: ["Atlas"], gatherMs: 60_000, context: true });
  for (let i = 1; i <= 5; i++) assert.equal((await call(h, h.bot, { name: `Helper ${i}`, purpose: "Helps." })).isError, false);
  const helper = named(h, "Helper 1")!.id;
  const grandchild = await call(h, helper, { name: "Grandchild", purpose: "Helps." });
  assert.equal(grandchild.isError, false, grandchild.text);
  const row = await h.run(h.store.bot(named(h, "Grandchild")!.id));
  assert.equal(row?.createdBy, helper, "who made it is still recorded");
  assert.equal(row?.createdByName, "Helper 1");
  assert.equal(h.daemon.bots().length, 1 + 5 + 1);
});

test("two calls in one turn for the same name make one bot", async () => {
  const h = await harness({ bots: ["Atlas"], gatherMs: 60_000, context: true });
  const both = await Promise.all([call(h, h.bot, { name: "Nova", purpose: "Helps." }), call(h, h.bot, { name: "Nova", purpose: "Helps." })]);
  assert.deepEqual(
    both.map((r) => r.isError),
    [false, true],
  );
  assert.match(both[1]!.text, /already a bot named Nova/);
  assert.equal(h.daemon.bots().filter((b) => b.name === "Nova").length, 1);
});

test("a Claude bot makes a bot through Top's tools over MCP, and can put it on Claude Code too", async () => {
  const fake = fakeClaude();
  const h = await harness({ bots: ["Atlas"], gatherMs: 0, claude: fake, models: { Atlas: "claude/sonnet" }, context: true });
  await h.run(h.daemon.start);
  await submit(h, h.bot, `call ${TOOL} ${JSON.stringify({ name: "Nova", purpose: "Reviews pull requests.", model: "claude/haiku" })}`);
  await until("Nova to be made", async () => (await settled(h)) && named(h, "Nova"), 10_000);
  const nova = named(h, "Nova")!;
  assert.equal(nova.model, "claude/haiku");
  assert.equal((await h.run(h.store.bot(nova.id)))?.createdBy, h.bot);
  const tool = (await h.entries(h.bot)).find((e) => e.kind === "tool");
  assert.ok(tool?.kind === "tool");
  assert.deepEqual(toWire(tool)?.kind === "tool" ? (toWire(tool) as { createdBot?: unknown }).createdBot : undefined, {
    id: nova.id,
    name: "Nova",
    purpose: "Reviews pull requests.",
  });
});
