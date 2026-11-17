/**
 * Permission requests (Collar's `ask_permission`): a bot asks, a client answers once, and the answer
 * comes back to the bot as its tool's result. Stop, a slow answer and a restart never count as an Allow.
 */
import assert from "node:assert/strict";
import * as Effect from "effect/Effect";
import { test } from "vitest";
import { textOf as textOfContent } from "../src/messages.ts";
import type { StoredEntry } from "../src/store.ts";
import { toWire } from "../src/wire.ts";
import { type Harness, harness, idle, until } from "./harness.ts";

const textOf = (entry: StoredEntry) => (entry.kind === "notice" ? entry.message.text : entry.kind === "files" ? "" : textOfContent(entry.message.content));
const toolResults = async (h: Harness, bot = h.bot) => (await h.entries(bot)).filter((e) => e.kind === "tool");
const pending = (h: Harness) => async () => h.daemon.permissions.pending()[0];
const answer = (h: Harness, id: string, bot: number, allow: boolean) => h.run(Effect.result(h.daemon.permissions.answer(id, bot, allow)));
const lastIsAnswer = async (h: Harness, bot = h.bot) => (await h.entries(bot)).at(-1)?.kind === "assistant" && (await idle(h, bot));

test("a bot asks, the user allows, and the bot gets the answer as its tool's result", async () => {
  const h = await harness();
  await h.run(h.daemon.start);
  await h.run(h.daemon.submit(h.bot, "r1", "ask permission to delete the 3 old backups", "followUp", null));
  const request = await until("the request", pending(h));
  assert.equal(request.bot, h.bot);
  assert.equal(request.action, "delete the 3 old backups");
  assert.equal(request.reason, "You asked me to check with you first.");
  // Clients show it where the bot asked: the call it came from, with what it asks.
  const asked = toWire((await h.entries()).find((e) => e.kind === "assistant")!);
  const call = asked?.kind === "assistant" ? asked.tools?.[0] : undefined;
  assert.equal(call?.id, request.toolCallId);
  assert.deepEqual(call?.permission, { action: "delete the 3 old backups", reason: "You asked me to check with you first." });

  assert.equal((await answer(h, request.id, h.bot, true))._tag, "Success");
  await until("the bot's answer", () => lastIsAnswer(h));
  const [result] = await toolResults(h);
  assert.equal(result?.kind === "tool" && result.message.toolName, "collar__ask_permission");
  assert.equal(textOf(result!), "Allowed by the user: delete the 3 old backups.");
  assert.equal((toWire(result!) as { permission?: string }).permission, "allowed");
  assert.deepEqual(h.daemon.permissions.pending(), []);
});

test("a denial is the answer too; a second answer, or one naming another bot, is refused", async () => {
  const h = await harness({ bots: ["Atlas", "Juniper"] });
  const [atlas, juniper] = h.bots as [number, number];
  await h.run(h.daemon.start);
  await h.run(h.daemon.submit(atlas, "r1", "ask permission to deploy web.", "followUp", null));
  const request = await until("the request", pending(h));

  const wrongBot = await answer(h, request.id, juniper, true);
  assert.equal(wrongBot._tag === "Failure" && wrongBot.failure._tag, "PermissionError");
  assert.equal(h.daemon.permissions.pending().length, 1, "still waiting for Atlas's answer");
  const unknown = await answer(h, "no-such-request", atlas, true);
  assert.equal(unknown._tag, "Failure");

  assert.equal((await answer(h, request.id, atlas, false))._tag, "Success");
  const again = await answer(h, request.id, atlas, true);
  assert.equal(again._tag === "Failure" && again.failure.message, "That request was already answered, or isn't waiting anymore.");

  await until("Atlas's answer", () => lastIsAnswer(h, atlas));
  const results = await toolResults(h, atlas);
  assert.equal(results.length, 1, "one result: the late Allow changed nothing");
  assert.equal(textOf(results[0]!), "Denied by the user: deploy web. Don't do it.");
  assert.equal((toWire(results[0]!) as { permission?: string }).permission, "denied");
  assert.deepEqual(await h.entries(juniper), [], "Juniper wasn't involved");
});

test("Stop withdraws the request: no answer is taken after it", async () => {
  const h = await harness();
  await h.run(h.daemon.start);
  await h.run(h.daemon.submit(h.bot, "r1", "ask permission to restart the database", "followUp", null));
  const request = await until("the request", pending(h));
  await h.run(h.daemon.stop(h.bot));
  await until("the request to go", () => h.daemon.permissions.pending().length === 0);
  assert.equal((await answer(h, request.id, h.bot, true))._tag, "Failure");
  await until("the bot to stop", () => idle(h));
  const results = await toolResults(h);
  assert.equal(results.length, 1);
  assert.doesNotMatch(textOf(results[0]!), /Allowed/);
  assert.equal((toWire(results[0]!) as { permission?: string }).permission, undefined, "no answer for clients either");
});

test("a slow answer moves to the background: the bot answers other messages meanwhile, and gets the answer by message", async () => {
  const h = await harness({ foregroundMs: 150, gatherMs: 50 });
  await h.run(h.daemon.start);
  await h.run(h.daemon.submit(h.bot, "r1", "ask permission to email the customer list", "followUp", null));
  const request = await until("the request", pending(h));
  await until("the call to move to the background", async () => (await toolResults(h)).some((e) => /moved to the background as job/.test(textOf(e))));
  await until("the bot to finish its turn", () => idle(h));

  // A message sent while the request waits is answered, not held up behind it.
  await h.run(h.daemon.submit(h.bot, "r2", "what's the queue depth?", "followUp", null));
  await until("the answer to the other message", async () => {
    const entries = await h.entries();
    const asked = entries.findIndex((e) => e.kind === "user" && e.requestId === "r2");
    return asked >= 0 && entries.slice(asked).some((e) => e.kind === "assistant") && (await idle(h));
  });
  assert.equal(h.daemon.permissions.pending()[0]?.id, request.id, "still waiting");

  assert.equal((await answer(h, request.id, h.bot, true))._tag, "Success");
  const message = await until("the answer's message", async () => (await h.entries()).find((e) => e.kind === "user" && e.source === "job"));
  assert.match(textOf(message), /^\[Background job 1 finished\] collar__ask_permission/);
  assert.match(textOf(message), /Allowed by the user: email the customer list\./);
  // Clients tie the message back to the call by its job, and read the answer from it.
  const moved = (await toolResults(h)).find((e) => /moved to the background/.test(textOf(e)))!;
  assert.equal((toWire(moved) as { job?: number }).job, 1);
  assert.deepEqual([(toWire(message) as { job?: number }).job, (toWire(message) as { permission?: string }).permission], [1, "allowed"]);
  await until("the bot to take it", () => lastIsAnswer(h));
});

test("a restart ends a waiting request unanswered: it isn't asked again, and nothing is allowed", async () => {
  const first = await harness({ foregroundMs: 60_000 });
  await first.run(first.daemon.start);
  await first.run(first.daemon.submit(first.bot, "r1", "ask permission to drop the staging table", "followUp", null));
  const request = await until("the request", pending(first));
  await first.close();

  const h = await harness({ foregroundMs: 60_000, dir: first.dir });
  assert.deepEqual(h.daemon.permissions.pending(), []);
  await h.run(h.daemon.start);
  await until("the bot to carry on", () => lastIsAnswer(h));
  const results = await toolResults(h);
  assert.equal(results.length, 1);
  assert.equal(results[0]!.kind === "tool" && results[0]!.outcome, "not_run");
  assert.doesNotMatch(textOf(results[0]!), /Allowed/);
  assert.deepEqual(h.daemon.permissions.pending(), [], "not asked again");
  assert.equal((await answer(h, request.id, h.bot, true))._tag, "Failure", "the old request's id means nothing now");
});

test("a request that waited in the background and was cut off by a restart says nobody answered", async () => {
  const first = await harness();
  const job = await first.run(first.store.startJob(first.bot, "1:2:call_x", "collar__ask_permission", "action: deploy web", "", Date.now() - 90_000));
  await first.close();

  const h = await harness({ dir: first.dir, gatherMs: 50 });
  await h.run(h.daemon.start);
  const message = await until("the cut-off message", async () => (await h.entries()).find((e) => e.kind === "user" && e.source === "job"));
  assert.match(textOf(message), new RegExp(`^\\[Background job ${job} was cut off\\] collar__ask_permission`));
  assert.match(textOf(message), /before the user answered\. Nothing was allowed/);
  assert.doesNotMatch(textOf(message), /may have taken effect/);
  const wired = toWire(message) as { job?: number; permission?: string };
  assert.equal(wired.job, job);
  assert.equal(wired.permission, undefined, "cut off: no answer");
});

test("a bot can't wait on its permission request in the background: the answer comes once, as a message the app shows", async () => {
  const h = await harness({ foregroundMs: 150, gatherMs: 50 });
  await h.run(h.daemon.start);
  await h.run(h.daemon.submit(h.bot, "r1", "ask permission to archive the old tickets", "followUp", null));
  const request = await until("the request", pending(h));
  await until("the call to move to the background", async () => (await toolResults(h)).some((e) => /moved to the background as job/.test(textOf(e))));

  const jobsTool = h.daemon.toolsOf(h.bot).find((t) => t.name === "collar__jobs")!;
  const waited = await h.run(jobsTool.run({ action: "wait", id: 1 }, { key: "k", bot: h.bot }));
  assert.match((waited.content[0] as { text: string }).text, /waiting for the user to answer/);

  assert.equal((await answer(h, request.id, h.bot, false))._tag, "Success");
  const message = await until("the answer's message", async () => (await h.entries()).find((e) => e.kind === "user" && e.source === "job"));
  assert.equal((toWire(message) as { permission?: string }).permission, "denied");
});
