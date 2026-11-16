/**
 * Permission requests (Collar's `ask_permission`): a bot asks without waiting, the request waits on the
 * daemon (also across a restart), a client answers it once, and what came of it is one `permission`
 * entry. An answer reaches the bot once, as a message; Stop withdraws a request and never counts as an Allow.
 */
import assert from "node:assert/strict";
import * as Effect from "effect/Effect";
import { test } from "vitest";
import { textOf as textOfContent } from "../src/messages.ts";
import type { StoredEntry } from "../src/store.ts";
import { toWire } from "../src/wire.ts";
import { type Harness, harness, idle, until } from "./harness.ts";

const textOf = (entry: StoredEntry) =>
  entry.kind === "notice" ? entry.message.text : entry.kind === "files" || entry.kind === "permission" ? "" : textOfContent(entry.message.content);
const waiting = (h: Harness) => h.run(h.daemon.permissions.waiting);
const answer = (h: Harness, id: number, bot: number, allow: boolean) => h.run(Effect.result(h.daemon.permissions.answer(id, bot, allow)));
const ofKind = async <K extends StoredEntry["kind"]>(h: Harness, kind: K, bot = h.bot) =>
  (await h.entries(bot)).filter((e): e is Extract<StoredEntry, { kind: K }> => e.kind === kind);
const messages = async (h: Harness, bot = h.bot) => (await ofKind(h, "user", bot)).filter((e) => e.source === "permission");
const lastIsAnswer = async (h: Harness, bot = h.bot) => (await h.entries(bot)).at(-1)?.kind === "assistant" && (await idle(h, bot));

/** Ask, and wait until the bot has finished the turn it asked in. */
const ask = async (h: Harness, action: string, bot = h.bot, requestId = `ask-${action}`) => {
  await h.run(h.daemon.submit(bot, requestId, `ask permission to ${action}`, "followUp", null));
  const request = await until("the request", async () => (await waiting(h)).find((r) => r.bot === bot && r.action === action));
  await until("the bot to end its turn", () => lastIsAnswer(h, bot));
  return request;
};

test("asking doesn't make the bot wait: the call's result carries the request, which clients show where it asked", async () => {
  const h = await harness();
  await h.run(h.daemon.start);
  const request = await ask(h, "delete the 3 old backups");
  assert.deepEqual(request, { id: request.id, bot: h.bot, action: "delete the 3 old backups", reason: "You asked me to check with you first." });

  const [result] = await ofKind(h, "tool");
  assert.match(textOf(result!), /^Asked the user: delete the 3 old backups\. Their answer will come to you as a message\./);
  assert.deepEqual((toWire(result!) as { permission?: unknown }).permission, {
    id: request.id,
    action: "delete the 3 old backups",
    reason: "You asked me to check with you first.",
  });
  assert.equal(result!.outcome, null, "it ran: nothing to settle");
  assert.deepEqual(await ofKind(h, "permission"), [], "nothing came of it yet");
});

test("the user allows: one entry says so, and the bot gets one message with the answer", async () => {
  const h = await harness({ gatherMs: 50 });
  await h.run(h.daemon.start);
  const request = await ask(h, "delete the 3 old backups");

  assert.equal((await answer(h, request.id, h.bot, true))._tag, "Success");
  const [settled] = await ofKind(h, "permission");
  assert.deepEqual(toWire(settled!), { seq: settled!.seq, bot: h.bot, at: settled!.at, kind: "permission", request: request.id, answer: "allowed" });
  assert.deepEqual(await waiting(h), []);

  await until("the bot to take the answer", async () => (await messages(h)).length === 1 && (await lastIsAnswer(h)));
  const [message] = await messages(h);
  assert.equal(textOf(message!), "[Permission] The user allowed: delete the 3 old backups.");
  assert.equal(message!.requestId, `permission:${request.id}`);
  assert.match(textOf((await ofKind(h, "assistant")).at(-1)!), /^Got your answer\. The user allowed/);
});

test("a denial is an answer too; a second answer, one naming another bot, or an unknown one is refused", async () => {
  const h = await harness({ bots: ["Atlas", "Juniper"], gatherMs: 50 });
  const [atlas, juniper] = h.bots as [number, number];
  await h.run(h.daemon.start);
  const request = await ask(h, "deploy web", atlas);

  const wrongBot = await answer(h, request.id, juniper, true);
  assert.equal(wrongBot._tag === "Failure" && wrongBot.failure._tag, "PermissionError");
  assert.equal((await waiting(h)).length, 1, "still waiting for Atlas's answer");
  assert.equal((await answer(h, 9_999, atlas, true))._tag, "Failure");

  assert.equal((await answer(h, request.id, atlas, false))._tag, "Success");
  const again = await answer(h, request.id, atlas, true);
  assert.equal(again._tag === "Failure" && again.failure.message, "That request was already answered, or isn't waiting anymore.");

  await until("Atlas to take the answer", async () => (await messages(h, atlas)).length === 1 && (await lastIsAnswer(h, atlas)));
  assert.deepEqual(
    (await ofKind(h, "permission", atlas)).map((e) => e.message),
    [{ request: request.id, answer: "denied" }],
    "one answer: the late Allow changed nothing",
  );
  assert.equal(textOf((await messages(h, atlas))[0]!), "[Permission] The user denied: deploy web. Don't do it.");
  assert.deepEqual(await h.entries(juniper), [], "Juniper wasn't involved");
});

test("two answers at once (two devices): the first wins and the bot hears once", async () => {
  const h = await harness({ gatherMs: 50 });
  await h.run(h.daemon.start);
  const request = await ask(h, "rotate the keys");
  const results = await Promise.all([answer(h, request.id, h.bot, true), answer(h, request.id, h.bot, false)]);
  assert.deepEqual(results.map((r) => r._tag).sort(), ["Failure", "Success"]);
  await until("the bot to take the answer", async () => (await messages(h)).length === 1 && (await lastIsAnswer(h)));
  assert.equal((await ofKind(h, "permission")).length, 1);
  assert.equal((await messages(h)).length, 1);
});

test("the bot stays responsive while a request waits: a message sent meanwhile is answered first", async () => {
  const h = await harness();
  await h.run(h.daemon.start);
  const request = await ask(h, "email the customer list");
  await h.run(h.daemon.submit(h.bot, "r2", "what's the queue depth?", "followUp", null));
  await until("the answer to the other message", async () => {
    const entries = await h.entries();
    const asked = entries.findIndex((e) => e.kind === "user" && e.requestId === "r2");
    return asked >= 0 && entries.slice(asked).some((e) => e.kind === "assistant") && (await idle(h));
  });
  assert.deepEqual(
    (await waiting(h)).map((r) => r.id),
    [request.id],
    "still waiting",
  );
});

test("Stop withdraws the bot's requests: an entry says so, nothing reaches the bot, and a later answer is refused", async () => {
  const h = await harness({ gatherMs: 50 });
  await h.run(h.daemon.start);
  const request = await ask(h, "restart the database");
  const before = (await h.entries()).length;
  await h.run(h.daemon.stop(h.bot));

  assert.deepEqual(await waiting(h), []);
  assert.deepEqual(
    (await ofKind(h, "permission")).map((e) => e.message),
    [{ request: request.id, answer: "withdrawn" }],
  );
  assert.equal((await answer(h, request.id, h.bot, true))._tag, "Failure");
  // No message, so no new task: the user stopped the bot.
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.ok(await idle(h));
  assert.equal((await h.entries()).length, before + 1, "only the withdrawal");
  assert.deepEqual(await messages(h), []);
});

test("a waiting request outlives a restart: it's still answerable, and the bot gets the answer once", async () => {
  const first = await harness({ gatherMs: 50 });
  await first.run(first.daemon.start);
  const request = await ask(first, "drop the staging table");
  await first.close();

  const h = await harness({ dir: first.dir, gatherMs: 50 });
  await h.run(h.daemon.start);
  await until("the bot to settle", () => idle(h));
  assert.deepEqual(await waiting(h), [request], "asked once, still waiting");
  assert.equal((await ofKind(h, "tool")).length, 1, "not asked again");

  assert.equal((await answer(h, request.id, h.bot, true))._tag, "Success");
  await until("the bot to take the answer", async () => (await messages(h)).length === 1 && (await lastIsAnswer(h)));
  assert.equal((await messages(h)).length, 1);
});

test("a call a restart cut off between asking and its result is settled with the request it made, never a second one", async () => {
  const h = await harness();
  const tool = h.daemon.toolsOf(h.bot).find((t) => t.name === "collar__ask_permission")!;
  const row = await h.run(h.daemon.permissions.ask(h.bot, `${h.bot}:5:call_1`, "deploy web", undefined));
  const recovered = await h.run(tool.recover!({ action: "deploy web" }, { key: `${h.bot}:5:call_1`, bot: h.bot }));
  assert.ok(recovered);
  assert.deepEqual((recovered.details as { permission: unknown }).permission, { id: row.id, action: "deploy web" });
  assert.equal(await h.run(tool.recover!({ action: "deploy web" }, { key: `${h.bot}:6:call_1`, bot: h.bot })), false, "never asked: not run");
  // The same tool-call id in a later answer is another call, so another request.
  const later = await h.run(h.daemon.permissions.ask(h.bot, `${h.bot}:9:call_1`, "deploy web", undefined));
  assert.notEqual(later.id, row.id);
  assert.equal((await waiting(h)).length, 2);
});

test("deleting a bot takes its waiting requests with it", async () => {
  const h = await harness({ bots: ["Atlas", "Juniper"] });
  const [atlas, juniper] = h.bots as [number, number];
  await h.run(h.daemon.start);
  await ask(h, "archive the logs", atlas);
  const kept = await ask(h, "archive the tickets", juniper);
  await h.run(h.daemon.deleteBot(atlas));
  assert.deepEqual(await waiting(h), [kept]);
});
