import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as Effect from "effect/Effect";
import Type from "typebox";
import { test } from "vitest";
import { MAX_HOPS } from "../src/botMessages.ts";
import { messagesGroup, rosterSection } from "../src/collar/messages.ts";
import { fakeClaude } from "../src/fakeClaude.ts";
import { textOf } from "../src/messages.ts";
import type { StoredEntry } from "../src/store.ts";
import { fromPromise, type TopTool, text } from "../src/tools.ts";
import { toWire } from "../src/wire.ts";
import { type Harness, harness, idle, until } from "./harness.ts";

const TOOL = "collar__message_bot";
const BOTS = ["Atlas", "Bolt"];

let sent = 0;
const submit = (h: Harness, bot: number, message: string) => h.run(h.daemon.submit(bot, `msg-${++sent}`, message, "followUp", null));

/** Runs the tool as a bot's call with this key would, the way a replay after a restart does too. */
async function call(h: Harness, bot: number, args: Record<string, unknown>, key = `k${++sent}`) {
  const tool = h.daemon.toolsOf(bot).find((t) => t.name === TOOL)!;
  const result = await h.run(tool.run(args, { key, bot }));
  return { text: (result.content[0] as { text: string }).text, isError: result.isError === true, details: result.details };
}

/** Marks the bot as having read what's in its inbox, without a model: what its runner does at the start of a turn. */
async function read(h: Harness, bot: number) {
  for (const row of await h.run(h.store.inbox(bot))) await h.run(h.store.place(bot, row.requestId, { role: "user", content: row.text, timestamp: row.at }));
}

const userTexts = async (h: Harness, bot: number) =>
  (await h.entries(bot)).flatMap((e) => (e.kind === "user" ? [{ text: textOf(e.message.content), source: e.source, peer: e.message.peer }] : []));
const toolTexts = async (h: Harness, bot: number) =>
  (await h.entries(bot)).flatMap((e) => (e.kind === "tool" && e.message.toolName === TOOL ? [textOf(e.message.content)] : []));
const settled = async (h: Harness) => {
  for (const bot of h.bots) if (!(await idle(h, bot))) return false;
  return true;
};

/** Two fake bots that wait (a long gather) instead of reading what comes in, so a test can read for them. */
const quiet = () => harness({ bots: BOTS, gatherMs: 60_000 });

test("a bot messages another by name and gets its reply as a message, once, in one round trip of turns", async () => {
  const h = await harness({ bots: BOTS, gatherMs: 0 });
  const [atlas, bolt] = h.bots as [number, number];
  await h.run(h.daemon.start);
  // Bolt's fake model replies because the message tells it to; the number is the first message's.
  const reply = JSON.stringify({ reply_to: 1, text: "pong" });
  await submit(h, atlas, `call ${TOOL} ${JSON.stringify({ to: "bolt", text: `call ${TOOL} ${reply}` })}`);
  await until("the reply to reach Atlas and both bots to settle", async () => (await settled(h)) && (await userTexts(h, atlas)).length === 2, 10_000);

  const got = await userTexts(h, bolt);
  assert.equal(got.length, 1, "Bolt got one message");
  assert.equal(got[0]!.source, "bot");
  assert.match(got[0]!.text, /^\[Message 1 from Atlas, another bot, not the user\. To answer, use collar__message_bot with reply_to: 1/);
  assert.deepEqual(got[0]!.peer, { id: 1, bot: atlas, name: "Atlas" });

  const back = (await userTexts(h, atlas))[1]!;
  assert.match(back.text, /^\[Reply 2 from Bolt to your message 1\. It needs no reply/);
  assert.match(back.text, /\npong$/);
  assert.deepEqual(back.peer, { id: 2, bot: bolt, name: "Bolt", replyTo: 1 });

  assert.match((await toolTexts(h, atlas))[0]!, /^Sent message 1 to Bolt\./);
  assert.match((await toolTexts(h, bolt))[0]!, /^Sent your reply to message 1 to Atlas \(as message 2\)\./);
  assert.equal((await h.run(h.store.botMessage(1)))?.state, "replied");
  assert.equal((await h.run(h.store.botMessage(2)))?.state, "reply");

  // What the apps get: the text as sent, who it's from, and the receipt as a card.
  const wire = (entry: StoredEntry | undefined) => (entry ? toWire(entry) : undefined);
  const placed = (await h.entries(bolt)).find((e) => e.kind === "user");
  assert.deepEqual(wire(placed), {
    seq: placed!.seq,
    bot: bolt,
    at: placed!.at,
    kind: "user",
    text: `call ${TOOL} ${reply}`,
    requestId: "bot:1",
    source: "bot",
    peer: { id: 1, bot: atlas, name: "Atlas" },
  });
  const receipt = wire((await h.entries(atlas)).find((e) => e.kind === "tool"));
  assert.ok(receipt?.kind === "tool");
  assert.deepEqual(receipt.botMessage, { id: 1, to: bolt, name: "Bolt", text: `call ${TOOL} ${reply}` });
});

test("a message waits for the turn its recipient is in, rather than steering into it", async () => {
  const gate = { release: () => {}, started: false };
  const slow: TopTool = {
    name: "slow__work",
    label: "Work",
    description: "Works until released.",
    parameters: Type.Object({}),
    run: () =>
      fromPromise(
        () =>
          new Promise((resolve) => {
            gate.started = true;
            gate.release = () => resolve(text("worked"));
          }),
      ),
  };
  const h = await harness({ bots: BOTS, gatherMs: 0, tools: [slow] });
  const [atlas, bolt] = h.bots as [number, number];
  await h.run(h.daemon.start);
  await submit(h, bolt, "call slow__work");
  await until("Bolt's tool to start", () => gate.started);
  assert.equal((await call(h, atlas, { to: "Bolt", text: "when you're free" })).isError, false);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal((await userTexts(h, bolt)).length, 1, "not delivered into the running turn");
  gate.release();
  await until("Bolt to read it", async () => (await settled(h)) && (await userTexts(h, bolt)).length === 2);
  const kinds = (await h.entries(bolt)).map((e) => e.kind);
  // user, assistant (call), tool, assistant (done), then the message as a turn of its own, and its answer.
  assert.deepEqual(kinds, ["user", "assistant", "tool", "assistant", "user", "assistant"]);
});

test("a call run again (as after a restart) finds what it sent and sends nothing more", async () => {
  const h = await quiet();
  const [atlas, bolt] = h.bots as [number, number];
  const first = await call(h, atlas, { to: "Bolt", text: "deploy is done" }, "1:5:call_a");
  const again = await call(h, atlas, { to: "Bolt", text: "deploy is done" }, "1:5:call_a");
  assert.equal(first.text, again.text);
  assert.deepEqual(first.details, again.details);
  assert.equal((await h.run(h.store.inbox(bolt))).length, 1, "one message queued");

  await read(h, bolt);
  const reply = await call(h, bolt, { reply_to: 1, text: "thanks" }, "2:7:call_b");
  const replayed = await call(h, bolt, { reply_to: 1, text: "thanks" }, "2:7:call_b");
  assert.equal(reply.isError, false);
  assert.equal(replayed.text, reply.text, "the replayed reply is the same reply, not 'already replied'");
  assert.equal((await h.run(h.store.inbox(atlas))).length, 1, "Atlas is woken once");
});

test("a message survives a restart before its recipient reads it, and the reply comes back once, with no turn run twice", async () => {
  const dir = mkdtempSync(join(tmpdir(), "top-messages-"));
  const first = await harness({ dir, bots: BOTS, gatherMs: 60_000 });
  const [atlas, bolt] = first.bots as [number, number];
  const reply = JSON.stringify({ reply_to: 1, text: "pong after restart" });
  assert.equal((await call(first, atlas, { to: "Bolt", text: `call ${TOOL} ${reply}` })).isError, false);
  assert.equal((await first.run(first.store.inbox(bolt))).length, 1);
  await first.close();

  const h = await harness({ dir, bots: BOTS, gatherMs: 0 });
  await h.run(h.daemon.start);
  await until("the reply to reach Atlas", async () => (await settled(h)) && (await userTexts(h, atlas)).length === 1, 10_000);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal((await userTexts(h, bolt)).length, 1, "Bolt read the message once");
  assert.equal((await h.entries(bolt)).filter((e) => e.kind === "tool").length, 1, "and replied once");
  assert.match((await userTexts(h, atlas))[0]!.text, /\npong after restart$/);
  assert.equal((await h.entries(atlas)).filter((e) => e.kind === "assistant").length, 1, "Atlas's one turn: the reply's");
});

test("a send cut off by a crash after it went out is settled by running the call again, which sends nothing more", async () => {
  const dir = mkdtempSync(join(tmpdir(), "top-messages-"));
  const first = await harness({ dir, bots: BOTS, gatherMs: 60_000 });
  const [atlas, bolt] = first.bots as [number, number];
  await first.run(first.daemon.start);
  await submit(first, atlas, `call ${TOOL} {"to":"Bolt","text":"once only"}`);
  await until("Atlas to send it", async () => (await idle(first, atlas)) && (await toolTexts(first, atlas)).length === 1);
  await first.close();

  // As if the daemon died after the message went out but before the call's result was saved.
  const db = new DatabaseSync(join(dir, "top.sqlite"));
  const call = db.prepare("SELECT seq FROM entries WHERE bot = ? AND kind = 'assistant' ORDER BY seq LIMIT 1").get(atlas) as { seq: number };
  db.prepare("DELETE FROM entries WHERE bot = ? AND seq > ?").run(atlas, call.seq);
  db.prepare("UPDATE bots SET run_active = 1 WHERE id = ?").run(atlas);
  db.close();

  const h = await harness({ dir, bots: BOTS, gatherMs: 60_000 });
  await h.run(h.daemon.start);
  await until("Atlas to settle the call", async () => (await idle(h, atlas)) && (await toolTexts(h, atlas)).length === 1);
  const result = (await h.entries(atlas)).find((e) => e.kind === "tool");
  assert.equal(result?.outcome, "replayed");
  assert.match((await toolTexts(h, atlas))[0]!, /^Sent message 1 to Bolt\./);
  await until("Bolt to settle", () => idle(h, bolt));
  assert.equal((await userTexts(h, bolt)).length, 1, "one message for Bolt");
  assert.equal(await h.run(h.store.botMessage(2)), undefined, "and only one sent");
});

test(`bots can trade ${MAX_HOPS} messages since the user last wrote, then the next is refused; the user writing starts over`, async () => {
  const h = await quiet();
  const [atlas, bolt] = h.bots as [number, number];
  const ping = async (text: string) => call(h, atlas, { to: "Bolt", text });
  assert.equal((await ping("one")).isError, false); // 1
  await read(h, bolt);
  assert.equal((await call(h, bolt, { reply_to: 1, text: "re one" })).isError, false); // 2
  await read(h, atlas);
  assert.equal((await ping("two")).isError, false); // 3
  await read(h, bolt);
  assert.equal((await call(h, bolt, { reply_to: 3, text: "re two" })).isError, false); // 4
  await read(h, atlas);
  const capped = await ping("three");
  assert.equal(capped.isError, true);
  assert.match(capped.text, new RegExp(`already ${MAX_HOPS} messages long since the user last wrote`));
  const chain = await h.run(h.store.botMessage(4));
  assert.deepEqual([chain?.chain, chain?.hop], [1, 4]);

  await submit(h, atlas, "carry on");
  await read(h, atlas);
  const fresh = await ping("three");
  assert.equal(fresh.isError, false, "the user wrote, so a new chain starts");
  const message = await h.run(h.store.botMessage(5));
  assert.deepEqual([message?.chain, message?.hop], [5, 1]);
});

test("the same text to the same bot twice in one exchange is refused, and so are replies that can't be", async () => {
  const h = await quiet();
  const [atlas, bolt] = h.bots as [number, number];
  assert.equal((await call(h, atlas, { to: "Bolt", text: "status?" })).isError, false);
  await read(h, bolt);
  assert.equal((await call(h, bolt, { reply_to: 1, text: "green" })).isError, false);
  await read(h, atlas);
  const repeat = await call(h, atlas, { to: "Bolt", text: "status?" });
  assert.equal(repeat.isError, true);
  assert.match(repeat.text, /already sent Bolt exactly this in this exchange/);

  assert.match((await call(h, bolt, { reply_to: 1, text: "again" })).text, /already replied to message 1/);

  // Twice from one turn the user started: the second is the same message, though neither carries a chain on.
  await submit(h, atlas, "ask Bolt");
  await read(h, atlas);
  assert.equal((await call(h, atlas, { to: "Bolt", text: "deploy?" })).isError, false);
  assert.match((await call(h, atlas, { to: "Bolt", text: "deploy?" })).text, /already sent Bolt exactly this/);
  assert.match((await call(h, atlas, { reply_to: 2, text: "thanks" })).text, /Bolt's reply to you, which takes none/);
  assert.match((await call(h, atlas, { reply_to: 1, text: "mine" })).text, /no bot sent you a message 1/);
  assert.match((await call(h, atlas, { reply_to: 99, text: "?" })).text, /no bot sent you a message 99/);
  assert.match((await call(h, atlas, { to: "atlas", text: "hi me" })).text, /that's you/);
});

test("names resolve case-insensitively; an unknown or shared name is refused with who there is", async () => {
  const h = await quiet();
  const [atlas] = h.bots as [number, number];
  const roster = [
    { id: atlas, name: "Atlas", about: "" },
    { id: 50, name: "Clio", about: "Writes." },
    { id: 51, name: "Clio", about: "Also writes." },
    { id: h.bots[1]!, name: "Bolt", about: "Builds." },
  ];
  const tool = messagesGroup({
    store: h.store,
    jobs: h.daemon.jobs,
    wakes: h.daemon.wakes,
    asks: h.daemon.asks,
    changed: h.daemon.changed,
    toolsOf: h.daemon.toolsOf,
    roster: Effect.succeed(roster),
    deliver: () => Effect.void,
    createBot: h.daemon.createBot,
  })[0]!;
  const run = async (args: Record<string, unknown>) => (await h.run(tool.run(args, { key: `r${++sent}`, bot: atlas }))).content[0] as { text: string };
  assert.match((await run({ to: "Nobody", text: "hi" })).text, /^Not sent: there's no bot named Nobody\. You can message: Clio, Clio, Bolt\.$/);
  assert.match((await run({ to: "clio", text: "hi" })).text, /2 bots are named Clio.* You can message: Clio, Clio, Bolt\.$/);
  assert.match((await run({ text: "hi" })).text, /say who it's for with `to`\. You can message: Clio, Clio, Bolt\./);
  assert.match((await run({ to: "atlas", text: "hi" })).text, /^Not sent: that's you\. You can message: Clio, Clio, Bolt\.$/);
  assert.match((await run({ to: "BOLT", text: "hi" })).text, /^Sent message 1 to Bolt\./);

  assert.equal(rosterSection(roster, atlas)?.split("\n").slice(2, -1).join("\n"), "- Clio: Writes.\n- Clio: Also writes.\n- Bolt: Builds.");
  assert.equal(rosterSection([roster[0]!], atlas), null, "a bot alone has no one to message, and no section");
});

test("each bot's instructions list the others it can message", async () => {
  const h = await harness({ bots: ["Atlas", "Bolt", "Clio"], gatherMs: 0 });
  const [atlas] = h.bots as [number, number];
  await h.run(h.daemon.start);
  await submit(h, atlas, "hello");
  await until("Atlas to answer", async () => (await idle(h, atlas)) && (await h.entries(atlas)).at(-1)?.kind === "assistant");
  const prompt = (await h.run(h.daemon.runner(atlas))).systemPrompt();
  const section = prompt?.sections?.bots ?? "";
  assert.match(section, /^<bots>\n/);
  assert.match(section, /\n- Bolt\n- Clio\n<\/bots>$/);
  assert.doesNotMatch(section, /Atlas/);
});

test("when the user stops the recipient before it replied, the sender hears so once, and an unread message is dropped", async () => {
  const h = await quiet();
  const [atlas, bolt] = h.bots as [number, number];
  await call(h, atlas, { to: "Bolt", text: "unread" });
  await call(h, atlas, { to: "Bolt", text: "read but unanswered" });
  await h.run(h.store.place(bolt, "bot:2", { role: "user", content: "read", timestamp: 1 }));
  await h.run(h.daemon.stop(bolt));
  await h.run(h.daemon.stop(bolt));
  assert.deepEqual(await h.run(h.store.inbox(bolt)), [], "Bolt won't read the unread one after all");
  const told = (await h.run(h.store.inbox(atlas))).map((row) => [row.requestId, row.text, row.mode, row.source]);
  assert.deepEqual(told, [
    ["bot-outcome:1", "[Message 1 to Bolt] Bolt won't reply: the user stopped it before it did.", "followUp", "bot"],
    ["bot-outcome:2", "[Message 2 to Bolt] Bolt won't reply: the user stopped it before it did.", "followUp", "bot"],
  ]);
  assert.match((await call(h, bolt, { reply_to: 2, text: "late" })).text, /ended when the user stopped you/);

  // Taken by Bolt's runner just before Stop dropped it, the message isn't saved at all.
  assert.equal(await h.run(h.store.place(bolt, "bot:1", { role: "user", content: "taken", timestamp: 2 })), undefined);

  await read(h, atlas);
  const outcome = (await h.entries(atlas)).find((e) => e.kind === "user");
  assert.deepEqual(outcome?.kind === "user" ? outcome.message.peer : undefined, { id: 1, bot: bolt, name: "Bolt", outcome: "stopped" });
});

test("when the recipient is deleted before it replied, the sender hears so once; a deleted sender's message can't be replied to", async () => {
  const h = await harness({ bots: ["Atlas", "Bolt", "Clio"], gatherMs: 60_000 });
  const [atlas, bolt, clio] = h.bots as [number, number, number];
  await call(h, atlas, { to: "Bolt", text: "are you there?" });
  await h.run(h.daemon.deleteBot(bolt));
  assert.deepEqual(
    (await h.run(h.store.inbox(atlas))).map((row) => row.text),
    ["[Message 1 to Bolt] Bolt won't reply: it was deleted before it did."],
  );
  assert.equal((await h.run(h.store.botMessage(1)))?.state, "deleted");

  await call(h, clio, { to: "Atlas", text: "ping from Clio" });
  await read(h, atlas);
  await h.run(h.daemon.deleteBot(clio));
  assert.equal((await h.run(h.store.inbox(atlas))).length, 0, "Clio's message to Atlas needs no word: Atlas is still here");
  const reply = await call(h, atlas, { reply_to: 2, text: "pong" });
  assert.equal(reply.isError, true);
  assert.match(reply.text, /Clio has been deleted, so there's no one to reply to/);
  // SQLite gives a new bot the deleted one's id once it's purged; Clio's message still can't reach it.
  await until("Clio to be purged", async () => (await h.run(h.store.bot(clio))) === undefined);
  const made = [await h.run(h.daemon.createBot("Dax", "")), await h.run(h.daemon.createBot("Eve", ""))];
  assert.ok(made.includes(clio), "Clio's id is reused");
  assert.match((await call(h, atlas, { reply_to: 2, text: "pong" })).text, /Clio has been deleted/);
  assert.match((await call(h, atlas, { to: "Bolt", text: "hello?" })).text, /there's no bot named Bolt\. You can message: Dax, Eve\./);
});

test("a message Stop drops while its Claude recipient is setting up the run never reaches Claude, then or in its next turn", async () => {
  const fake = fakeClaude();
  let hold: Promise<void> | undefined;
  let release = () => {};
  let parked = false;
  const h = await harness({
    bots: BOTS,
    gatherMs: 0,
    claude: fake,
    models: { Atlas: "claude/sonnet" },
    store: (store) => ({
      ...store,
      setRunActive: (bot, active) =>
        active && hold
          ? Effect.sync(() => {
              parked = true;
            }).pipe(Effect.andThen(Effect.promise(() => hold!)), Effect.andThen(store.setRunActive(bot, active)))
          : store.setRunActive(bot, active),
    }),
  });
  const [atlas, bolt] = h.bots as [number, number];
  await h.run(h.daemon.start);
  hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  await call(h, bolt, { to: "Atlas", text: "secret plan, then stopped" });
  await until("Atlas to park while setting up its run", () => parked);
  await h.run(h.daemon.stop(atlas));
  hold = undefined;
  release();
  await until("Atlas to settle", () => idle(h, atlas));
  await submit(h, atlas, "hello again");
  await until("Atlas to answer", async () => (await idle(h, atlas)) && (await h.entries(atlas)).at(-1)?.kind === "assistant", 10_000);
  const said = fake.prompts
    .map(({ message: { content } }) => (typeof content === "string" ? content : content.map((b) => (b.type === "text" ? b.text : "")).join("\n")))
    .join("\n");
  assert.match(said, /hello again/);
  assert.doesNotMatch(said, /secret plan/, "Claude never got the dropped message");
  assert.equal((await userTexts(h, atlas)).filter((m) => m.source === "bot").length, 0, "nor is it in the transcript");
  assert.equal((await h.run(h.store.botMessage(1)))?.state, "stopped");
});

test("a Claude bot messages and replies the same way, through Top's tools over MCP", async () => {
  const fake = fakeClaude();
  const h = await harness({ bots: BOTS, gatherMs: 0, claude: fake, models: { Atlas: "claude/sonnet" } });
  const [atlas, bolt] = h.bots as [number, number];
  await h.run(h.daemon.start);
  // Bolt (Top's loop) asks Atlas (Claude Code), telling it how to answer; Atlas's reply wakes Bolt.
  const reply = JSON.stringify({ reply_to: 1, text: "pong from Claude" });
  await submit(h, bolt, `call ${TOOL} ${JSON.stringify({ to: "Atlas", text: `call ${TOOL} ${reply}` })}`);
  await until("Atlas's reply to reach Bolt", async () => (await settled(h)) && (await userTexts(h, bolt)).length === 2, 10_000);
  assert.match((await userTexts(h, bolt))[1]!.text, /^\[Reply 2 from Atlas to your message 1\.[^\n]*\npong from Claude$/);
  assert.match(
    fake.prompts
      .map(({ message: { content } }) => (typeof content === "string" ? content : content.map((b) => (b.type === "text" ? b.text : "")).join("\n")))
      .join("\n"),
    /\[Message 1 from Bolt, another bot/,
    "Claude read who it was from",
  );
  assert.match((await toolTexts(h, atlas))[0]!, /^Sent your reply to message 1 to Bolt/);

  // And a new message from Claude.
  await submit(h, atlas, `call ${TOOL} {"to":"Bolt","text":"hello from Claude"}`);
  await until("Bolt to read it", async () => (await settled(h)) && (await userTexts(h, bolt)).length === 3, 10_000);
  assert.deepEqual((await userTexts(h, bolt))[2]!.peer, { id: 3, bot: atlas, name: "Atlas" });
});

test("Stop drops an unread message from a bot deleted meanwhile, telling no one; a user's message is the user's whatever its request id", async () => {
  const h = await harness({ bots: ["Atlas", "Bolt", "Clio"], gatherMs: 60_000 });
  const [atlas, bolt, clio] = h.bots as [number, number, number];
  await call(h, clio, { to: "Atlas", text: "from a bot about to go" });
  await h.run(h.daemon.deleteBot(clio));
  assert.equal((await h.run(h.store.inbox(atlas))).length, 1, "still queued for Atlas");
  await h.run(h.daemon.stop(atlas));
  assert.deepEqual(await h.run(h.store.inbox(atlas)), []);
  assert.deepEqual(await h.run(h.store.inbox(bolt)), []);

  // A client picks its own request ids; one that looks like a bot message's is still the user's own.
  await h.run(h.daemon.submit(bolt, "bot:1", "from the user", "followUp", null));
  await read(h, bolt);
  const placed = (await userTexts(h, bolt))[0]!;
  assert.deepEqual([placed.source, placed.peer], [null, undefined]);
  assert.equal(await h.run(h.store.chainOf(bolt)), undefined, "and it starts a new chain");
});
