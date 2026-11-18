import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type Credential, type CredentialInfo, type CredentialStore, getCurrentSystemMessage, type SystemMessage } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { MAX_CONTEXT_FILE_BYTES } from "@top/protocol";
import * as Effect from "effect/Effect";
import Type from "typebox";
import { afterEach, test, vi } from "vitest";
import { SUMMARY_HEAD } from "../src/compaction.ts";
import { fileSection, readContextFile, saveContextFile, soulIdentity, versionOf } from "../src/contextFiles.ts";
import type { Context } from "../src/fake-bots.ts";
import { type TranscriptMessage, textOf } from "../src/messages.ts";
import { fromPromise, type TopTool, text } from "../src/tools.ts";
import { BEFORE_CONTEXT_FILES, type Harness, harness, idle, until } from "./harness.ts";

const node = <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices>) => Effect.runPromise(Effect.provide(effect, NodeServices.layer));
const folderOf = (h: Harness, name = "Atlas") => join(h.dir, "bots", name);
const put = (h: Harness, file: string, content: string, name = "Atlas") => {
  mkdirSync(folderOf(h, name), { recursive: true });
  writeFileSync(join(folderOf(h, name), file), content);
};
const section = (h: Harness, file: string, content: string) => `<file name="${file}" path="${join(folderOf(h), file)}">\n${content}\n</file>`;
const systems = (messages: readonly TranscriptMessage[]) => messages.filter((m): m is SystemMessage => m.role === "system");

let sent = 0;
async function ask(h: Harness, message: string, bot = h.bot) {
  await h.run(h.daemon.submit(bot, `ctx-${++sent}`, message, "followUp", null));
  await until(`an answer to "${message}"`, async () => (await idle(h, bot)) && (await h.entries(bot)).at(-1)?.kind === "assistant", 10_000);
}

async function recording(options: Parameters<typeof harness>[0] = {}) {
  const requests: TranscriptMessage[][] = [];
  const h = await harness({
    context: true,
    ...options,
    onRequest: (context: Context) => requests.push(structuredClone(context.messages) as TranscriptMessage[]),
  });
  await h.run(h.daemon.start);
  return { h, requests };
}

test("a context file loads whole, or not at all with the reason; missing and empty ones aren't shown", async () => {
  const { h } = await recording();
  const folder = folderOf(h);
  mkdirSync(folder, { recursive: true });
  const read = (name: "SOUL.md" | "AGENTS.md" | "USER.md" | "MEMORY.md") => node(readContextFile(folder, name));

  assert.deepEqual(await read("MEMORY.md"), { name: "MEMORY.md", path: join(folder, "MEMORY.md"), content: "", version: "" });
  assert.equal(fileSection(await read("MEMORY.md")), null);
  writeFileSync(join(folder, "MEMORY.md"), "  \n\n");
  assert.equal(fileSection(await read("MEMORY.md")), null, "only whitespace");

  writeFileSync(join(folder, "USER.md"), "Prefers short answers.\n");
  const user = await read("USER.md");
  assert.equal(user.content, "Prefers short answers.\n");
  assert.equal(user.version, versionOf("Prefers short answers.\n"));
  assert.equal(fileSection(user), section(h, "USER.md", "Prefers short answers."));

  writeFileSync(join(folder, "AGENTS.md"), "x".repeat(MAX_CONTEXT_FILE_BYTES + 1));
  const big = await read("AGENTS.md");
  assert.equal(big.content, undefined, "none of it, rather than a cut-off copy");
  assert.match(big.error!, /over the 8 KB limit, so none of it was loaded/);
  assert.match(fileSection(big)!, /^<file name="AGENTS.md" path=".*" loaded="no">\nIt's 8\.0 KB, over the 8 KB limit.*Fix it with your tools/s);
  writeFileSync(join(folder, "AGENTS.md"), "é".repeat(MAX_CONTEXT_FILE_BYTES / 2));
  assert.equal((await read("AGENTS.md")).error, undefined, "the limit is in bytes, and this is exactly at it");

  mkdirSync(join(folder, "SOUL.md"));
  assert.equal((await read("SOUL.md")).error, "It isn't a file.");
  rmSync(join(folder, "SOUL.md"), { recursive: true });
  writeFileSync(join(folder, "SOUL.md"), "# Atlas\n");
  chmodSync(join(folder, "SOUL.md"), 0o000);
  if (process.getuid?.() !== 0) assert.match((await read("SOUL.md")).error!, /^It can't be read: .*permission denied/i);
  chmodSync(join(folder, "SOUL.md"), 0o644);
});

test("the name and the line under it in the app come from SOUL.md", () => {
  assert.deepEqual(soulIdentity("# Nova\n\nWatches the build\nand reports breakages.\n\n## Voice\nDry."), {
    name: "Nova",
    about: "Watches the build and reports breakages.",
  });
  assert.deepEqual(soulIdentity("\n# **Nova** #\n"), { name: "Nova" });
  assert.deepEqual(soulIdentity("Some notes\n\n# Personality\nDry."), {}, "a heading further down isn't a name");
  assert.deepEqual(soulIdentity("No heading at all"), {});
  assert.deepEqual(soulIdentity(undefined), {});
  assert.equal(soulIdentity(`# ${"N".repeat(60)}`).name?.length, 40);
});

test("saving a file needs the version it was opened at, so an edit made since isn't lost", async () => {
  const { h } = await recording();
  const folder = folderOf(h);
  const saved = await node(saveContextFile(folder, "USER.md", "Lives in Prague.\n", ""));
  assert.equal(saved, versionOf("Lives in Prague.\n"));
  writeFileSync(join(folder, "USER.md"), "Lives in Brno.\n");
  await assert.rejects(node(saveContextFile(folder, "USER.md", "Lives in Vienna.\n", saved)), /changed since you opened it/);
  assert.equal(readFileSync(join(folder, "USER.md"), "utf8"), "Lives in Brno.\n");
  await assert.rejects(node(saveContextFile(folder, "USER.md", "x".repeat(MAX_CONTEXT_FILE_BYTES + 1), versionOf("Lives in Brno.\n"))), /under 8 KB/);
  await node(saveContextFile(folder, "USER.md", "", versionOf("Lives in Brno.\n")));
  assert.equal(readFileSync(join(folder, "USER.md"), "utf8"), "");

  const big = "x".repeat(MAX_CONTEXT_FILE_BYTES + 1);
  writeFileSync(join(folder, "MEMORY.md"), big);
  const unreadable = (await node(readContextFile(folder, "MEMORY.md"))).version;
  await assert.rejects(node(saveContextFile(folder, "MEMORY.md", "short", unreadable)), /can't be saved here: It's 8\.0 KB/);
  assert.equal(readFileSync(join(folder, "MEMORY.md"), "utf8"), big, "a file Settings couldn't show is never overwritten from it");
});

test("files go with the first request; an edit adds just that file's new version at the next message, after the same prefix", async () => {
  const { h, requests } = await recording();
  put(h, "SOUL.md", "# Atlas\n\nWatches the build.\n");
  put(h, "USER.md", "Prefers short answers.\n");

  await ask(h, "hello");
  const [first] = requests;
  const baseline = getCurrentSystemMessage(first!)!;
  assert.deepEqual(Object.keys(baseline.sections!).slice(-3), ["context_files", "SOUL.md", "USER.md"], "missing files aren't sections");
  assert.match(baseline.sections!.context_files!, /SOUL\.md: who you are[\s\S]*Top's instructions win[\s\S]*If SOUL\.md doesn't name you, you're Atlas\./);
  assert.equal(baseline.sections!["USER.md"], section(h, "USER.md", "Prefers short answers."));

  await ask(h, "again");
  assert.deepEqual(requests[1]!.slice(0, first!.length), first, "the earlier request is the start of the next, byte for byte");
  assert.deepEqual(
    requests[1]!.slice(first!.length).map((m) => m.role),
    ["assistant", "user"],
    "nothing changed, nothing added",
  );

  put(h, "MEMORY.md", "Deploys go through staging.\n");
  writeFileSync(join(folderOf(h), "USER.md"), "Prefers short answers.\n");
  await ask(h, "third");
  const third = requests[2]!;
  assert.deepEqual(third.slice(0, requests[1]!.length), requests[1]);
  const added = third.slice(requests[1]!.length);
  assert.deepEqual(
    added.map((m) => m.role),
    ["assistant", "system", "user"],
  );
  assert.deepEqual((added[1] as SystemMessage).sections, { "MEMORY.md": section(h, "MEMORY.md", "Deploys go through staging.") }, "only the file that changed");
  assert.equal((added[1] as SystemMessage).content, "", "the update is instructions, not a message from the user");
  assert.equal(textOf(added[2]!.content as never), "third");

  const update = async (change: () => void, message: string) => {
    change();
    const before = requests.length;
    await ask(h, message);
    const request = requests[before]!;
    assert.deepEqual(request.slice(0, requests[before - 1]!.length), requests[before - 1], `${message}: the prefix stays`);
    return systems(request.slice(requests[before - 1]!.length)).map((m) => m.sections);
  };
  const userFile = join(folderOf(h), "USER.md");
  assert.deepEqual(await update(() => writeFileSync(userFile, "Prefers long answers.\n"), "B"), [
    { "USER.md": section(h, "USER.md", "Prefers long answers.") },
  ]);
  assert.deepEqual(
    await update(() => writeFileSync(userFile, "Prefers short answers.\n"), "back to A"),
    [{ "USER.md": section(h, "USER.md", "Prefers short answers.") }],
    "A → B → A sends A again: B is what the model has now",
  );
  assert.deepEqual(await update(() => rmSync(join(folderOf(h), "MEMORY.md")), "deleted"), [{ "MEMORY.md": null }]);
  assert.deepEqual(await update(() => writeFileSync(userFile, "Prefers short answers.\n\n"), "same text"), [], "only whitespace changed");

  const shown = await h.entries();
  assert.ok(!shown.some((e) => (e.kind as string) === "system"), "updates never show in the conversation");
  assert.deepEqual(
    shown.filter((e) => e.kind === "user").map((e) => textOf(e.message.content as never)),
    ["hello", "again", "third", "B", "back to A", "deleted", "same text"],
  );
});

test("an edit made during a turn waits for the next message; a follow-up queued meanwhile is that next message", async () => {
  let release: () => void = () => {};
  const hold: TopTool = {
    name: "hold__tool",
    label: "Hold",
    description: "Runs until the test lets it go.",
    parameters: Type.Object({}),
    run: () => fromPromise(() => new Promise((resolve) => (release = () => resolve(text("held"))))),
  };
  const { h, requests } = await recording({ tools: [hold] });
  put(h, "MEMORY.md", "v1\n");
  await h.run(h.daemon.submit(h.bot, "hold-1", "call hold__tool {}", "followUp", null));
  await until("the tool to run", async () => (await h.run(h.daemon.runner(h.bot))).status().tool === "hold__tool");
  put(h, "MEMORY.md", "v2\n");
  await h.run(h.daemon.submit(h.bot, "hold-2", "and then?", "followUp", null));
  release();
  await until("both answers", async () => (await idle(h)) && (await h.entries()).filter((e) => e.kind === "assistant").length === 3, 10_000);

  const effective = (request: readonly TranscriptMessage[]) => getCurrentSystemMessage(request)!.sections!["MEMORY.md"];
  assert.equal(requests.length, 3);
  assert.equal(effective(requests[0]!), section(h, "MEMORY.md", "v1"));
  assert.equal(effective(requests[1]!), section(h, "MEMORY.md", "v1"), "the turn that was running carries on as it started");
  assert.equal(requests[1]!.at(-1)!.role, "toolResult");
  const next = requests[2]!;
  assert.deepEqual(next.slice(0, requests[1]!.length), requests[1]);
  assert.deepEqual(
    next.slice(requests[1]!.length).map((m) => m.role),
    ["assistant", "system", "user"],
  );
  assert.equal(effective(next), section(h, "MEMORY.md", "v2"));
});

test("after a restart, the conversation is the one the model saw, not rebuilt from the files as they are now", async () => {
  const first = await recording();
  put(first.h, "SOUL.md", "# Atlas\n\nv1\n");
  await ask(first.h, "hello");
  const context = await first.h.run(first.h.store.context(first.h.bot));
  await first.h.close();

  writeFileSync(join(folderOf(first.h), "SOUL.md"), "# Atlas\n\nv2\n");
  const { h, requests } = await recording({ dir: first.h.dir });
  assert.deepEqual(await h.run(h.store.context(h.bot)), context);
  await ask(h, "still there?");
  assert.deepEqual(requests[0]!.slice(0, context.length), context);
  assert.deepEqual(
    systems(requests[0]!.slice(context.length)).map((m) => m.sections),
    [{ "SOUL.md": section(h, "SOUL.md", "# Atlas\n\nv2") }],
  );
});

test("a restart between saving an update and asking the model doesn't send the update twice", async () => {
  const first = await recording();
  put(first.h, "MEMORY.md", "v1\n");
  await ask(first.h, "hello");
  put(first.h, "MEMORY.md", "v2\n");
  const timestamp = Date.now();
  await first.h.run(
    first.h.store.append(first.h.bot, "system", {
      role: "system",
      content: "",
      sections: { "MEMORY.md": section(first.h, "MEMORY.md", "v2") },
      timestamp,
    }),
  );
  await first.h.run(first.h.store.submit(first.h.bot, "crashed", "where were we?", "followUp", null));
  await first.h.close();

  const { h, requests } = await recording({ dir: first.h.dir });
  await until("the queued message's answer", async () => (await idle(h)) && (await h.entries()).at(-1)?.kind === "assistant");
  const request = requests[0]!;
  assert.equal(systems(request).filter((m) => m.sections && "MEMORY.md" in m.sections).length, 2, "v1 at the start, v2 once");
  assert.deepEqual(
    request.slice(-2).map((m) => m.role),
    ["system", "user"],
  );
});

test("a follow-up queued while a turn retries and fails is answered after it, in order", async () => {
  const { h } = await recording();
  await h.run(h.daemon.submit(h.bot, "fails", "fail always", "followUp", null));
  await until("the retry", async () => (await h.run(h.daemon.runner(h.bot))).status().status === "retrying");
  await h.run(h.daemon.submit(h.bot, "next", "and then?", "followUp", null));
  await until("both turns", async () => (await idle(h)) && (await h.entries()).filter((e) => e.kind === "assistant").length === 2, 10_000);
  const kinds = (await h.entries()).map((e) =>
    e.kind === "user" ? textOf(e.message.content as never) : e.kind === "assistant" ? (e.message.errorMessage ? "failed" : "answer") : e.kind,
  );
  assert.deepEqual(kinds, ["fail always", "failed", "and then?", "answer"]);
});

test("a failed request is retried with the same context, and the update isn't added again", async () => {
  const { h, requests } = await recording();
  put(h, "MEMORY.md", "v1\n");
  await ask(h, "hello");
  put(h, "MEMORY.md", "v2\n");
  await ask(h, "fail once please");
  assert.equal(requests.length, 3);
  assert.deepEqual(requests[2], requests[1], "the retry sends exactly what the failed request did");
  assert.equal(systems(requests[2]!).length, 2);
});

test("compaction makes the latest files the new baseline and drops the versions they replaced, keeping every message", async () => {
  const { h, requests } = await recording({ compactAtTokens: 1_500 });
  put(h, "USER.md", "u0\n");
  const compacted = async () => (await h.entries()).some((e) => e.kind === "notice" && /^Compacted/.test(e.message.text));
  let n = 0;
  while (!(await compacted())) {
    assert.ok(++n <= 12, "it compacts within a dozen messages");
    writeFileSync(join(folderOf(h), "USER.md"), `u${n}\n`);
    await ask(h, `Question ${n}: tell me about topic ${n}`);
  }
  const at = requests.findIndex((r) => r.some((m) => m.role === "user" && textOf(m.content as never).startsWith(SUMMARY_HEAD)));
  const after = requests[at]!;
  const [baseline, ...rest] = systems(after);
  assert.equal(after[0], baseline, "one system message leads");
  assert.ok(
    rest.every((m) => after.indexOf(m) > after.findIndex((x) => x.role === "user")),
    "any other is after the summary",
  );
  assert.equal(getCurrentSystemMessage(after)!.sections!["USER.md"], section(h, "USER.md", `u${n}`));
  const superseded = JSON.stringify(after);
  for (let old = 0; old < n - 1; old++) assert.ok(!superseded.includes(`>\\nu${old}\\n<`), `u${old} is gone`);
  assert.ok(baseline!.sections!.context_files, "the guide is in the baseline");

  const stored = await h.entries();
  assert.equal(stored.filter((e) => e.kind === "user").length, n, "every message is still in the history");

  await ask(h, "after the compaction");
  const later = requests.at(-1)!;
  assert.deepEqual(later.slice(0, after.length), after, "the new baseline is stable too");
});

test("bots from before context files get their name and description in SOUL.md, once, without overwriting one that's there", async () => {
  const setup = await harness({ bots: ["Atlas", "Lark", "Wren"], context: true });
  const dir = setup.dir;
  await setup.close();
  const db = new DatabaseSync(join(dir, "top.sqlite"));
  db.exec(BEFORE_CONTEXT_FILES);
  db.exec(`UPDATE bots SET description = 'Watches the build.' WHERE name = 'Atlas';
    UPDATE bots SET description = 'Answers mail.' WHERE name = 'Lark'`);
  db.close();
  rmSync(join(dir, "bots"), { recursive: true, force: true });
  mkdirSync(join(dir, "bots", "Lark"), { recursive: true });
  writeFileSync(join(dir, "bots", "Lark", "SOUL.md"), "# Lark\n\nWritten by hand.\n");
  writeFileSync(join(dir, "bots", "Wren"), "a file where Wren's folder goes");

  const soul = (name: string) => readFileSync(join(dir, "bots", name, "SOUL.md"), "utf8");
  const h = await harness({ dir, context: true });
  assert.equal(soul("Atlas"), "# Atlas\n\nWatches the build.\n");
  assert.equal(soul("Lark"), "# Lark\n\nWritten by hand.\n\nAnswers mail.\n", "added under what was there, nothing lost");
  assert.deepEqual(
    (await h.run(h.store.legacySouls)).map((s) => s.name),
    ["Wren"],
    "Wren's couldn't be written, so it waits",
  );
  const atlas = h.daemon.bots().find((b) => b.name === "Atlas")!;
  assert.equal(atlas.description, "Watches the build.");
  await h.close();

  rmSync(join(dir, "bots", "Wren"));
  const again = await harness({ dir, context: true });
  assert.equal(soul("Wren"), "# Wren\n");
  assert.deepEqual(await again.run(again.store.legacySouls), []);
  assert.equal(soul("Lark"), "# Lark\n\nWritten by hand.\n\nAnswers mail.\n", "twice is the same as once");
  await again.close();

  const crashed = new DatabaseSync(join(dir, "top.sqlite"));
  crashed.exec("INSERT INTO legacy_souls (bot, name, description) SELECT id, name, 'Watches the build.' FROM bots WHERE name = 'Atlas'");
  crashed.close();
  const resumed = await harness({ dir, context: true });
  assert.equal(soul("Atlas"), "# Atlas\n\nWatches the build.\n", "a migration cut off after the file was written finishes without writing it twice");
  assert.deepEqual(await resumed.run(resumed.store.legacySouls), []);
  await resumed.close();

  const full = `# Lark\n\n${"y".repeat(MAX_CONTEXT_FILE_BYTES - 20)}\n`;
  writeFileSync(join(dir, "bots", "Lark", "SOUL.md"), full);
  const later = new DatabaseSync(join(dir, "top.sqlite"));
  later.exec("INSERT INTO legacy_souls (bot, name, description) SELECT id, name, 'Answers mail, and much more besides.' FROM bots WHERE name = 'Lark'");
  later.close();
  const waiting = await harness({ dir, context: true });
  assert.equal(soul("Lark"), full, "no room: SOUL.md isn't pushed over the limit");
  assert.deepEqual(
    (await waiting.run(waiting.store.legacySouls)).map((s) => s.name),
    ["Lark"],
    "and the description waits in the database",
  );
});

test("two bots from before whose names share a folder don't merge into one SOUL.md", async () => {
  const setup = await harness({ bots: ["Sc/out", "Sc_out"], context: true });
  const dir = setup.dir;
  await setup.close();
  const db = new DatabaseSync(join(dir, "top.sqlite"));
  db.exec(BEFORE_CONTEXT_FILES);
  db.exec("UPDATE bots SET description = 'Second.' WHERE name = 'Sc_out'");
  db.close();
  const h = await harness({ dir, context: true });
  assert.equal(readFileSync(join(dir, "bots", "Sc_out", "SOUL.md"), "utf8"), "# Sc/out\n");
  assert.deepEqual(
    (await h.run(h.store.legacySouls)).map((s) => [s.name, s.description]),
    [["Sc_out", "Second."]],
  );
});

test("SOUL.md names the bot in the app; the folder keeps the name it was made with", async () => {
  const { h } = await recording();
  const made = await h.run(h.daemon.createBot("Scout", "Watches the build and reports breakages."));
  assert.equal(readFileSync(join(folderOf(h, "Scout"), "SOUL.md"), "utf8"), "# Scout\n\nWatches the build and reports breakages.\n");
  const summary = () => h.daemon.bots().find((b) => b.id === made)!;
  assert.deepEqual([summary().name, summary().description], ["Scout", "Watches the build and reports breakages."]);

  const [soul] = await h.run(h.daemon.contextFiles(made));
  assert.equal(soul!.name, "SOUL.md");
  await h.run(h.daemon.saveContextFile(made, "SOUL.md", "# Nova\n\nKeeps an eye on the build.\n", soul!.version));
  await until("the new name", () => summary().name === "Nova");
  assert.equal(summary().description, "Keeps an eye on the build.");
  assert.ok(existsSync(join(folderOf(h, "Scout"), "SOUL.md")));
  await assert.rejects(h.run(h.daemon.saveContextFile(made, "SOUL.md", "# Other\n", soul!.version)), /changed since you opened it/);

  await assert.rejects(h.run(h.daemon.createBot("nova", "")), /already a bot named nova\./);
  await assert.rejects(h.run(h.daemon.createBot("Scout", "")), /already a bot named Scout \(it's called Nova now\)/);
  await h.run(h.daemon.createBot("Sc/out", ""));
  await assert.rejects(h.run(h.daemon.createBot("Sc_out", "")), /would share Sc\/out's folder/);

  rmSync(join(folderOf(h, "Scout"), "SOUL.md"));
  await ask(h, "who are you?", made);
  await until("the name it was made with", () => summary().name === "Scout");

  await h.run(h.daemon.deleteBot(made));
  await until("the bot to go", () => !h.daemon.has(made));
  put(h, "MEMORY.md", "Scout's notes.\n", "Scout");
  await assert.rejects(h.run(h.daemon.createBot("Scout", "")), /still has MEMORY\.md from an earlier bot/);
  assert.equal(readFileSync(join(folderOf(h, "Scout"), "MEMORY.md"), "utf8"), "Scout's notes.\n");
});

class SignedIn implements CredentialStore {
  readonly credentials: Record<string, Credential>;
  constructor(credentials: Record<string, Credential>) {
    this.credentials = credentials;
  }
  async read(providerId: string) {
    return this.credentials[providerId];
  }
  async list(): Promise<readonly CredentialInfo[]> {
    return Object.entries(this.credentials).map(([providerId, c]) => ({ providerId, type: c.type }));
  }
  async modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>) {
    const next = (await fn(this.credentials[providerId])) ?? this.credentials[providerId]!;
    this.credentials[providerId] = next;
    return next;
  }
  async delete() {}
}

type Event = Record<string, unknown> & { type: string };
const sse = (events: readonly Event[], numbered: boolean) =>
  new Response(events.map((event, i) => `event: ${event.type}\ndata: ${JSON.stringify(numbered ? { ...event, sequence_number: i } : event)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });

const openaiReply = (n: number) => {
  const usage = {
    input_tokens: 10,
    output_tokens: 5,
    total_tokens: 15,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  };
  const item = {
    type: "message",
    id: `msg_${n}`,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: `Answer ${n}.`, annotations: [] }],
  };
  return sse(
    [
      { type: "response.created", response: { id: `resp_${n}`, status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id: `resp_${n}`, status: "completed", output: [], usage } },
    ],
    true,
  );
};

const anthropicReply = (n: number) =>
  sse(
    [
      {
        type: "message_start",
        message: {
          id: `msg_${n}`,
          type: "message",
          role: "assistant",
          model: "claude-opus-5-5",
          content: [],
          stop_reason: null,
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `Answer ${n}.` } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
      { type: "message_stop" },
    ],
    false,
  );

afterEach(() => vi.unstubAllGlobals());

async function payloads(provider: "openai" | "anthropic") {
  const bodies: Record<string, unknown>[] = [];
  const url = provider === "openai" ? "https://api.openai.com/v1/responses" : "https://api.anthropic.com/v1/messages";
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const target = input instanceof Request ? input.url : String(input);
    if (!target.startsWith(url)) throw new Error(`The test reached for ${target}`);
    bodies.push(JSON.parse(String(init?.body ?? (input instanceof Request ? await input.text() : ""))));
    return provider === "openai" ? openaiReply(bodies.length) : anthropicReply(bodies.length);
  });
  const credentials: Record<string, Credential> =
    provider === "openai"
      ? { openai: { type: "oauth", access: "test-access", refresh: "test-refresh", expires: Date.now() + 3_600_000 } }
      : { anthropic: { type: "api_key", key: "test-key" } };
  const id = provider === "openai" ? "openai/gpt-6.1-sol" : "anthropic/claude-opus-5-5";
  const h = await harness({ context: true, model: { models: builtinModels({ credentials: new SignedIn(credentials) }), id } });
  await h.run(h.daemon.start);
  put(h, "SOUL.md", "# Atlas\n\nWatches the build.\n");
  await ask(h, "hello");
  await ask(h, "again");
  put(h, "MEMORY.md", "Deploys go through staging.\n");
  await ask(h, "third");
  return bodies;
}

const withoutCacheMark = (messages: unknown): Record<string, unknown>[] =>
  (JSON.parse(JSON.stringify(messages), (key, v) => (key === "cache_control" ? undefined : v)) as Record<string, unknown>[]).map((m) =>
    typeof m.content === "string" ? { ...m, content: [{ type: "text", text: m.content }] } : m,
  );

test("OpenAI Responses: the update goes in place as a developer message, after an input prefix and tools that don't change", async () => {
  const [one, two, three] = await payloads("openai");
  const input = (body: Record<string, unknown> | undefined) => body!.input as Record<string, unknown>[];
  for (const body of [two, three]) {
    assert.deepEqual(body!.tools, one!.tools);
    assert.deepEqual(body!.instructions, one!.instructions);
    assert.equal(body!.prompt_cache_key, one!.prompt_cache_key);
  }
  assert.deepEqual(input(two).slice(0, input(one).length), input(one));
  assert.deepEqual(input(three).slice(0, input(two).length), input(two));
  const added = input(three).slice(input(two).length);
  assert.deepEqual(
    added.map((item) => item.role ?? item.type),
    ["assistant", "developer", "user"],
  );
  assert.match(
    JSON.stringify(added[1]!.content),
    /^"Updated system prompt section \\"MEMORY.md\\":\\n\\n<file name=\\"MEMORY.md\\" path=\\".*MEMORY.md\\">\\nDeploys go through staging.\\n<\/file>"$/,
  );
  const leading = input(one).filter((item) => item.role === "developer" && typeof item.content === "string");
  assert.equal(leading.length, 1);
  assert.match(String(leading[0]!.content), /<context_files>[\s\S]*# Atlas/);
});

test("Anthropic Messages: system and tools stay the same, and the update is a system message in place; only the cache mark moves", async () => {
  // pi-ai marks the last message for caching, turning its string content into the one text block it stands for.
  const [one, two, three] = await payloads("anthropic");
  const messages = (body: Record<string, unknown> | undefined) => withoutCacheMark(body!.messages);
  for (const body of [two, three]) {
    assert.deepEqual(body!.system, one!.system);
    assert.deepEqual(body!.tools, one!.tools);
  }
  assert.deepEqual(messages(two).slice(0, messages(one).length), messages(one));
  assert.deepEqual(messages(three).slice(0, messages(two).length), messages(two));
  const added = messages(three).slice(messages(two).length);
  assert.deepEqual(
    added.map((m) => m.role),
    ["assistant", "user", "system", "system"],
    "pi-ai holds a system update until after the next user message, where Anthropic accepts it",
  );
  assert.deepEqual(added[3], messages(two).at(-1), "the last is the effort note pi-ai adds after every message");
  assert.match(JSON.stringify(added[2]!.content), /Updated system prompt section \\"MEMORY.md\\"[\s\S]*Deploys go through staging/);
  assert.match(JSON.stringify(one!.system), /<context_files>[\s\S]*# Atlas/);
});
