import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { test } from "vitest";
import { textOf as textOfContent } from "../src/messages.ts";
import type { StoredEntry } from "../src/store.ts";
import type { StartRequest, Tasks } from "../src/tasks/coordinator.ts";
import { type FakeHarness, type FakeHarnessConfig, fakeHarness } from "../src/tasks/fake.ts";
import type { HarnessEvent } from "../src/tasks/harness.ts";
import { toWire } from "../src/wire.ts";
import { botFolder } from "../src/workspace.ts";
import { type Harness, harness, until } from "./harness.ts";

type Setup = { h: Harness; fake: FakeHarness; tasks: Tasks; folder: (bot?: number) => string };

async function setup(
  options: { harness?: FakeHarnessConfig; fake?: FakeHarness; bots?: string[]; maxTasks?: number; dir?: string; start?: boolean } = {},
): Promise<Setup> {
  const fake = options.fake ?? fakeHarness({ stepMs: 30, ...options.harness });
  const names = options.bots ?? ["Atlas"];
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), "top-tasks-"));
  for (const name of names) mkdirSync(botFolder(join(dir, "bots"), name), { recursive: true });
  const h = await harness({ dir, harnesses: [fake], context: true, bots: names, maxTasks: options.maxTasks, taskCancelGraceMs: 300, gatherMs: 20 });
  if (options.start !== false) await h.run(h.daemon.start);
  const folder = (bot = h.bot) => botFolder(join(dir, "bots"), names[h.bots.indexOf(bot)]!);
  return { h, fake, tasks: h.daemon.tasks!, folder };
}

let keys = 0;
const startE = (s: Setup, request: Partial<StartRequest> & { prompt: string }) =>
  s.tasks.start({ bot: s.h.bot, key: `key-${++keys}`, harness: "fake", ...request });
const start = (s: Setup, request: Partial<StartRequest> & { prompt: string }) => s.h.run(startE(s, request));
const attempt = <A, E>(s: Setup, effect: Effect.Effect<A, E>) => s.h.run(Effect.result(effect));
const failure = async <A, E extends { message: string }>(s: Setup, effect: Effect.Effect<A, E>) => {
  const result = await attempt(s, effect);
  assert.equal(result._tag, "Failure", "it should be refused");
  return (result as { failure: E }).failure.message;
};
const task = (s: Setup, id: string) => s.h.run(s.h.store.tasks.task(id)).then((t) => t!);
const ended = (s: Setup, id: string) =>
  until(`task ${id} to end`, async () => {
    const t = await task(s, id);
    return ["completed", "failed", "cancelled"].includes(t.state) && t;
  });
const inState = (s: Setup, id: string, state: string) => until(`task ${id} to be ${state}`, async () => (await task(s, id)).state === state);
const pending = (s: Setup, id: string) => s.h.run(s.h.store.tasks.inputsOf(id)).then((rows) => rows.filter((r) => r.state === "pending"));
const notes = async (s: Setup, bot?: number) => {
  const entries = await s.h.entries(bot ?? s.h.bot);
  const inbox = await s.h.run(s.h.store.inbox(bot ?? s.h.bot));
  const users = entries.filter((e): e is Extract<StoredEntry, { kind: "user" }> => e.kind === "user" && e.source === "task");
  return [...users.map((e) => textOfContent(e.message.content)), ...inbox.filter((r) => r.source === "task").map((r) => r.text)];
};

test("a task in the bot's own folder runs at once, ends with its answer, and the bot hears once", async () => {
  const s = await setup();
  const { snapshot, created } = await start(s, { prompt: "fix the login bug" });
  assert.equal(created, true);
  assert.equal(snapshot.session.approved, true, "its own folder needs no approval");
  assert.equal(snapshot.session.cwd, s.folder());
  const done = await ended(s, snapshot.task.id);
  assert.equal(done.state, "completed");
  assert.equal(done.result, "Done: fix the login bug");
  assert.deepEqual(done.usage, { inputTokens: 100, outputTokens: 20 });
  assert.match(done.title, /fix the login bug/);
  assert.equal(s.fake.sessions.length, 1);
  assert.equal(s.fake.sessions[0]!.closed, true, "the harness process is closed when the task ends");
  assert.equal(s.fake.sessions[0]!.spec.policy, "workspace_write", "the default policy keeps the sandbox");

  const told = await until("the bot to be told", async () => {
    const n = await notes(s);
    return n.length ? n : undefined;
  });
  assert.equal(told.length, 1);
  assert.match(told[0]!, new RegExp(`^\\[Task ${snapshot.task.id} completed\\] fix the login bug \\(Fake harness\\)`));
  assert.match(told[0]!, /Done: fix the login bug/);
  assert.match(told[0]!, new RegExp(`"session": "${snapshot.session.id}"`));

  const read = await s.h.run(s.tasks.read(s.h.bot, snapshot.task.id, 0, 3));
  assert.deepEqual(
    read.events.map((e) => e.kind),
    ["state", "state", "status"],
  );
  assert.equal(read.more, true);
  const rest = await s.h.run(s.tasks.read(s.h.bot, snapshot.task.id, read.cursor, 200));
  assert.equal(rest.more, false);
  assert.ok(
    rest.events.every((e) => e.seq > read.cursor),
    "a cursor reads only what came after it",
  );
  assert.deepEqual(
    rest.events.filter((e) => e.kind === "state").map((e) => e.text),
    ["running", "completed"],
  );
  assert.ok(rest.events.some((e) => e.kind === "file_change" && e.text === "~ src/app.ts"));

  const again = await start(s, { prompt: "fix the login bug", key: `key-${keys}` });
  assert.equal(again.created, false, "the same call (key) never starts a second task");
  assert.equal(again.snapshot.task.id, snapshot.task.id);
  assert.equal(s.fake.sessions.length, 1);
});

test("another folder, and full access anywhere, wait for the user; only the user can allow it", async () => {
  const s = await setup();
  const elsewhere = mkdtempSync(join(tmpdir(), "top-elsewhere-"));
  const { snapshot } = await start(s, { prompt: "tidy up", cwd: elsewhere });
  assert.equal(snapshot.session.approved, false);
  await inState(s, snapshot.task.id, "waiting_for_input");
  const [ask] = await pending(s, snapshot.task.id);
  assert.equal(ask!.kind, "workspace");
  assert.equal(ask!.spec.userOnly, true);
  assert.match(ask!.title, /^Let Fake harness work in /);
  assert.equal(s.fake.sessions.length, 0, "nothing started before the user's answer");

  assert.match(
    await failure(s, s.tasks.respond("bot", s.h.bot, snapshot.task.id, ask!.id, { decision: "allow" })),
    /Only the user can let a harness work in a folder/,
  );
  await s.h.run(s.tasks.respond("user", undefined, snapshot.task.id, ask!.id, { decision: "allow" }));
  assert.equal((await ended(s, snapshot.task.id)).state, "completed");
  assert.equal(s.fake.sessions[0]!.spec.cwd, (await import("node:fs")).realpathSync(elsewhere));

  const full = await start(s, { prompt: "deploy", policy: "full_access" });
  assert.equal(full.snapshot.session.approved, false, "full access needs the user even in the bot's own folder");
  await inState(s, full.snapshot.task.id, "waiting_for_input");
  const [fullAsk] = await pending(s, full.snapshot.task.id);
  assert.match(fullAsk!.detail ?? "", /full access: no sandbox and no approvals/);
  await s.h.run(s.tasks.respond("user", undefined, full.snapshot.task.id, fullAsk!.id, { decision: "deny" }));
  const denied = await ended(s, full.snapshot.task.id);
  assert.equal(denied.state, "failed");
  assert.match(denied.error!, /The user didn't let Fake harness work in/);
  assert.equal(s.fake.sessions.length, 1, "a denied task never starts the harness");

  assert.match(await failure(s, startE(s, { prompt: "x", cwd: join(elsewhere, "missing") })), /There's no folder/);
});

test("approvals go to the user; the bot may only deny, and the first answer wins", async () => {
  const s = await setup();
  const { snapshot } = await start(s, { prompt: "needs approval" });
  await inState(s, snapshot.task.id, "waiting_for_input");
  const [ask] = await pending(s, snapshot.task.id);
  assert.equal(ask!.kind, "approval");
  assert.equal(ask!.title, "Run `rm -rf build`");
  assert.deepEqual(ask!.spec.decisions, ["allow", "allow_for_session", "deny"]);
  assert.equal(s.h.daemon.bots()[0] && (await until("the sidebar count", () => s.h.daemon.bots()[0]!.approvals === 1)), true);
  assert.deepEqual(await notes(s), [], "an approval the bot can't give doesn't wake it");

  assert.match(await failure(s, s.tasks.respond("bot", s.h.bot, snapshot.task.id, ask!.id, { decision: "allow" })), /Only the user can allow this/);
  assert.match(await failure(s, s.tasks.respond("user", undefined, snapshot.task.id, ask!.id, { decision: "maybe" as never })), /Decide with `decision`/);
  await s.h.run(s.tasks.respond("bot", s.h.bot, snapshot.task.id, ask!.id, { decision: "deny", message: "not now" }));
  assert.match(await failure(s, s.tasks.respond("user", undefined, snapshot.task.id, ask!.id, { decision: "allow" })), /already answered by the bot/);
  const done = await ended(s, snapshot.task.id);
  assert.equal(done.result, "Left build/ alone.");

  const second = await start(s, { prompt: "needs approval again" });
  await inState(s, second.snapshot.task.id, "waiting_for_input");
  const [ask2] = await pending(s, second.snapshot.task.id);
  await s.h.run(s.tasks.respond("user", undefined, second.snapshot.task.id, ask2!.id, { decision: "allow" }));
  assert.equal((await ended(s, second.snapshot.task.id)).result, "Removed build/.");
  const read = await s.h.run(s.tasks.read(s.h.bot, second.snapshot.task.id, 0, 200));
  assert.ok(read.events.some((e) => e.kind === "answer" && /allow by the user/.test(e.text)));
});

test("questions wake the bot, which may answer; a secret goes only to the harness, never to storage", async () => {
  const s = await setup();
  const { snapshot } = await start(s, { prompt: "a question please" });
  await inState(s, snapshot.task.id, "waiting_for_input");
  const [ask] = await pending(s, snapshot.task.id);
  assert.equal(ask!.kind, "question");
  assert.equal(ask!.spec.userOnly, undefined);
  const told = await until("the bot to hear about the question", async () => (await notes(s)).find((n) => n.includes("needs input")));
  assert.match(told, /Which database\?/);
  assert.match(told, /"request": \d+/);

  assert.match(await failure(s, s.tasks.respond("bot", s.h.bot, snapshot.task.id, ask!.id, { answers: {} })), /Answer question "db"/);
  assert.match(await failure(s, s.tasks.respond("bot", s.h.bot, snapshot.task.id, ask!.id, { answers: { db: ["a", "b"] } })), /takes one answer/);
  assert.match(await failure(s, s.tasks.respond("bot", s.h.bot, snapshot.task.id, ask!.id, { answers: { db: ["x"], zz: ["y"] } })), /has no question "zz"/);
  await s.h.run(s.tasks.respond("bot", s.h.bot, snapshot.task.id, ask!.id, { answers: { db: ["SQLite"] } }));
  assert.equal((await ended(s, snapshot.task.id)).result, "Using SQLite.");

  const secret = await start(s, { prompt: "secret question" });
  await inState(s, secret.snapshot.task.id, "waiting_for_input");
  const [ask2] = await pending(s, secret.snapshot.task.id);
  assert.equal(ask2!.spec.userOnly, true);
  assert.match(await failure(s, s.tasks.respond("bot", s.h.bot, secret.snapshot.task.id, ask2!.id, { answers: { token: ["x"] } })), /asks for a secret/);
  const value = "tok-SUPERSECRET-12345";
  await s.h.run(s.tasks.respond("user", undefined, secret.snapshot.task.id, ask2!.id, { answers: { token: [value] } }));
  assert.equal((await ended(s, secret.snapshot.task.id)).result, `Got a token of ${value.length} characters.`);
  const stored = (await s.h.run(s.h.store.tasks.input(ask2!.id)))!;
  assert.deepEqual(stored.answer, { secret: true });
  await s.h.close();
  for (const file of ["top.sqlite", "top.sqlite-wal"]) {
    let bytes = "";
    try {
      bytes = readFileSync(join(s.h.dir, file)).toString("latin1");
    } catch {}
    assert.ok(!bytes.includes(value), `the secret isn't in ${file}`);
  }
});

test("steer goes into the running turn, queue runs after it, and an ended task takes no messages", async () => {
  const s = await setup({ harness: { stepMs: 80 } });
  const { snapshot } = await start(s, { prompt: "build the thing" });
  await inState(s, snapshot.task.id, "running");
  await until("the turn to start", () => s.fake.sessions[0]?.turns.length === 1);
  const steered = await s.h.run(s.tasks.send(s.h.bot, snapshot.task.id, "steer-1", "steer", "use tabs"));
  assert.equal(steered.message.state, "sent");
  assert.deepEqual(s.fake.sessions[0]!.steered, ["use tabs"]);
  const duplicate = await s.h.run(s.tasks.send(s.h.bot, snapshot.task.id, "steer-1", "steer", "use tabs"));
  assert.equal(duplicate.duplicate, true, "a replayed call isn't sent twice");
  assert.deepEqual(s.fake.sessions[0]!.steered, ["use tabs"]);

  const queued = await s.h.run(s.tasks.send(s.h.bot, snapshot.task.id, "queue-1", "queue", "now write the tests"));
  assert.equal(queued.message.state, "pending");
  const done = await ended(s, snapshot.task.id);
  assert.equal(done.state, "completed");
  assert.equal(done.result, "Done: now write the tests", "the task ends after its queued turn");
  assert.deepEqual(
    s.fake.sessions[0]!.turns.map((t) => t.text),
    ["build the thing", "now write the tests"],
  );
  assert.match(
    await failure(s, s.tasks.send(s.h.bot, snapshot.task.id, "late", "queue", "more")),
    /has ended \(completed\)\. To carry on, call collar__task_start with "session"/,
  );
});

test("steering needs a running turn and a harness that can; unsupported features say so", async () => {
  const s = await setup({ harness: { capabilities: { steer: false, fork: false } }, maxTasks: 1 });
  const blocker = await start(s, { prompt: "run forever" });
  await inState(s, blocker.snapshot.task.id, "running");
  assert.match(await failure(s, s.tasks.send(s.h.bot, blocker.snapshot.task.id, "s1", "steer", "hi")), /Fake harness can't take steering messages/);
  const waiting = await start(s, { prompt: "second" });
  assert.equal((await task(s, waiting.snapshot.task.id)).state, "queued", "only one runs at a time here");
  await s.h.run(s.tasks.cancel(s.h.bot, blocker.snapshot.task.id));
  await ended(s, waiting.snapshot.task.id);
  assert.match(await failure(s, startE(s, { prompt: "branch", session: waiting.snapshot.session.id, fork: true, harness: undefined })), /can't branch/);
  assert.match(await failure(s, startE(s, { prompt: "x", options: { colour: "red" } })), /Bad options for Fake harness: .*takes speed/);
  assert.match(await failure(s, startE(s, { prompt: "x", harness: "nope" })), /There's no harness "nope"/);
  assert.match(await failure(s, startE(s, { prompt: "x", harness: undefined })), /Say which harness/);
});

test("cancel interrupts a running turn, never starts a queued one, and leaves an ended task as it was", async () => {
  const s = await setup({ maxTasks: 1 });
  const running = await start(s, { prompt: "run forever" });
  await inState(s, running.snapshot.task.id, "running");
  const queued = await start(s, { prompt: "wait in line" });
  await s.h.run(s.tasks.send(s.h.bot, running.snapshot.task.id, "q-1", "queue", "later"));

  const cancelled = await s.h.run(s.tasks.cancel(s.h.bot, queued.snapshot.task.id));
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.task.state, "cancelled");
  assert.equal(s.fake.sessions.length, 1, "the queued task never reached the harness");

  const stop = await s.h.run(s.tasks.cancel(s.h.bot, running.snapshot.task.id));
  assert.equal(stop.task.state, "cancelled");
  assert.equal(s.fake.sessions[0]!.interrupted, 1);
  assert.equal(s.fake.sessions[0]!.closed, true);
  assert.equal(s.fake.sessions[0]!.turns.length, 1, "the queued message was dropped, not run");
  const messages = await s.h.run(s.h.store.tasks.pendingMessages(running.snapshot.task.id));
  assert.deepEqual(messages, []);

  const again = await s.h.run(s.tasks.cancel(s.h.bot, running.snapshot.task.id));
  assert.equal(again.cancelled, false);
  const finished = await start(s, { prompt: "quick one" });
  await ended(s, finished.snapshot.task.id);
  const late = await s.h.run(s.tasks.cancel(s.h.bot, finished.snapshot.task.id));
  assert.deepEqual([late.cancelled, late.task.state], [false, "completed"], "cancelling after the end changes nothing");

  const told = await until("the bot to hear of both cancellations", async () => {
    const n = await notes(s);
    return n.filter((t) => t.includes("was cancelled")).length === 2 && n;
  });
  assert.ok(told.length >= 3);
});

test("cancelling while the harness is still starting never runs the prompt", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const base = fakeHarness({ stepMs: 20 });
  const slow: FakeHarness = {
    ...base,
    open: async (spec, emit) => {
      await gate;
      return base.open(spec, emit);
    },
  };
  const s = await setup({ fake: slow });
  const { snapshot } = await start(s, { prompt: "do work" });
  await inState(s, snapshot.task.id, "starting");
  const cancelling = s.h.run(s.tasks.cancel(s.h.bot, snapshot.task.id));
  await new Promise((resolve) => setTimeout(resolve, 30));
  release();
  const result = await cancelling;
  assert.equal(result.task.state, "cancelled");
  await until("the session that opened late to be closed", () => base.sessions[0]?.closed);
  assert.equal(base.sessions[0]!.turns.length, 0, "the prompt was never sent");
});

test("tasks and sessions belong to their bot", async () => {
  const s = await setup({ bots: ["Atlas", "Juniper"] });
  const [atlas, juniper] = s.h.bots as [number, number];
  const { snapshot } = await start(s, { prompt: "quick" });
  await ended(s, snapshot.task.id);
  for (const effect of [
    s.tasks.read(juniper, snapshot.task.id, 0, 10),
    s.tasks.send(juniper, snapshot.task.id, "k", "queue", "x"),
    s.tasks.cancel(juniper, snapshot.task.id),
    s.tasks.wait(juniper, snapshot.task.id, 0, "end"),
  ] as Effect.Effect<unknown, { message: string }>[])
    assert.match(await failure(s, effect), /You have no task/);
  assert.match(await failure(s, s.tasks.start({ bot: juniper, key: "j-1", prompt: "steal", session: snapshot.session.id })), /You have no session/);
  assert.equal((await s.h.run(s.tasks.read(atlas, snapshot.task.id, 0, 1))).task.id, snapshot.task.id);
});

test("a session carries on in a new task, can be branched, and only one task drives it at a time", async () => {
  const s = await setup();
  const first = await start(s, { prompt: "step one" });
  await ended(s, first.snapshot.task.id);
  const session = (await s.h.run(s.h.store.tasks.session(first.snapshot.session.id)))!;
  assert.ok(session.externalId?.startsWith("fake-"), "the harness's own id is kept");

  const next = await start(s, { prompt: "run forever", session: session.id, harness: undefined });
  assert.equal(next.snapshot.session.id, session.id);
  await inState(s, next.snapshot.task.id, "running");
  assert.equal(s.fake.sessions[1]!.spec.resume, session.externalId);
  assert.equal(s.fake.sessions[1]!.spec.fork, false);
  assert.match(await failure(s, startE(s, { prompt: "too", session: session.id, harness: undefined })), /is busy with task/);
  assert.match(await failure(s, startE(s, { prompt: "x", session: session.id, harness: undefined, model: "other" })), /Branch it/);
  assert.match(await failure(s, startE(s, { prompt: "x", session: session.id, harness: undefined, policy: "read_only" })), /runs with policy/);

  const branch = await start(s, { prompt: "try another way", session: session.id, fork: true, harness: undefined, model: "other" });
  assert.notEqual(branch.snapshot.session.id, session.id);
  assert.equal(branch.snapshot.session.parent, session.id);
  await ended(s, branch.snapshot.task.id);
  assert.equal(s.fake.sessions[2]!.spec.resume, session.externalId);
  assert.equal(s.fake.sessions[2]!.spec.fork, true);
  assert.equal(s.fake.sessions[2]!.spec.model, "other");
  await s.h.run(s.tasks.cancel(s.h.bot, next.snapshot.task.id));
});

test("a harness that's missing or crashes fails the task with what to do, keeping the session", async () => {
  const missing = await setup({ harness: { unavailable: "Fake isn't installed: install it." } });
  const a = await start(missing, { prompt: "x" });
  const failed = await ended(missing, a.snapshot.task.id);
  assert.equal(failed.state, "failed");
  assert.equal(failed.error, "Fake isn't installed: install it.");

  const s = await setup();
  const b = await start(s, { prompt: "please crash" });
  const crashed = await ended(s, b.snapshot.task.id);
  assert.equal(crashed.state, "failed");
  assert.match(crashed.error!, /it crashed\. Its session ses_\w+ is kept: to carry on, call collar__task_start/);
  const c = await start(s, { prompt: "this will fail" });
  assert.equal((await ended(s, c.snapshot.task.id)).error, "The fake turn failed.");
});

test("wait returns on input or the end, times out with timedOut, and a waiter gets the news instead of a message", async () => {
  const s = await setup({ harness: { stepMs: 60 } });
  const { snapshot } = await start(s, { prompt: "a question" });
  const first = await s.h.run(s.tasks.wait(s.h.bot, snapshot.task.id, 5_000, "input_or_end"));
  assert.equal(first.timedOut, false);
  assert.equal(first.snapshot.task.state, "waiting_for_input");
  assert.equal(first.snapshot.inputs.length, 1);
  const short = await s.h.run(s.tasks.wait(s.h.bot, snapshot.task.id, 50, "end"));
  assert.equal(short.timedOut, true);

  const end = s.h.run(s.tasks.wait(s.h.bot, snapshot.task.id, 5_000, "end"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  await s.h.run(s.tasks.respond("user", undefined, snapshot.task.id, first.snapshot.inputs[0]!.id, { answers: { db: ["Postgres"] } }));
  const last = await end;
  assert.equal(last.timedOut, false);
  assert.equal(last.snapshot.task.state, "completed");
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.ok(!(await notes(s)).some((n) => n.includes("completed")), "the waiting call had the result, so no message too");
});

test("reads are bounded and old events are dropped past the limit", async () => {
  const s = await setup();
  const { snapshot } = await start(s, { prompt: "quick" });
  await ended(s, snapshot.task.id);
  const big = "x".repeat(5_000);
  await s.h.run(
    s.h.store.tasks.appendEvents(Array.from({ length: 30 }, (_, i) => ({ task: snapshot.task.id, bot: s.h.bot, at: i, kind: "message" as const, text: big }))),
  );
  const read = await s.h.run(s.tasks.read(s.h.bot, snapshot.task.id, 0, 200));
  assert.ok(read.events.reduce((n, e) => n + e.text.length, 0) <= 24_000 + 5_000, "a read stays under its size budget");
  assert.equal(read.more, true);
  await s.h.run(s.h.store.tasks.pruneEvents(snapshot.task.id, 5));
  const after = await s.h.run(s.h.store.tasks.events(snapshot.task.id, 0, 200));
  assert.equal(after.events.length, 5, "only the newest are kept");
  const pruned = await s.h.run(s.tasks.read(s.h.bot, snapshot.task.id, 1, 200));
  assert.equal(pruned.pruned, true, "a reader whose cursor fell off the start is told");
});

test("a restart cuts off a started task without running it again, and keeps one still waiting for the user", async () => {
  const dir = mkdtempSync(join(tmpdir(), "top-tasks-restart-"));
  const first = await setup({ dir });
  const running = await start(first, { prompt: "run forever" });
  await inState(first, running.snapshot.task.id, "running");
  const elsewhere = mkdtempSync(join(tmpdir(), "top-elsewhere-"));
  const waiting = await start(first, { prompt: "over there", cwd: elsewhere });
  await inState(first, waiting.snapshot.task.id, "waiting_for_input");
  await first.h.run(first.h.store.tasks.addMessage({ task: running.snapshot.task.id, bot: first.h.bot, key: "m", mode: "queue", text: "then this" }));
  await first.h.close();

  const second = await setup({ dir });
  const cut = await task(second, running.snapshot.task.id);
  assert.equal(cut.state, "failed");
  assert.match(
    cut.error!,
    /^Cut off: the daemon restarted while it ran, so Fake harness stopped with it\. It may have made some of its changes\. Its session ses_\w+ is kept/,
  );
  assert.match(cut.error!, /1 queued message was not sent/);
  assert.equal(second.fake.sessions.length, 0, "nothing was started again");
  const told = await until("the bot to hear it was cut off", async () => (await notes(second)).find((n) => n.includes(running.snapshot.task.id)));
  assert.match(told, /failed\]/);

  assert.equal((await task(second, waiting.snapshot.task.id)).state, "waiting_for_input", "the user can still answer");
  const [ask] = await pending(second, waiting.snapshot.task.id);
  await second.h.run(second.tasks.respond("user", undefined, waiting.snapshot.task.id, ask!.id, { decision: "allow" }));
  assert.equal((await ended(second, waiting.snapshot.task.id)).state, "completed");
});

test("deleting a bot cancels its tasks and removes them with it; Stop cancels them too", async () => {
  const s = await setup({ bots: ["Atlas", "Juniper"] });
  const [atlas, juniper] = s.h.bots as [number, number];
  const mine = await s.h.run(s.tasks.start({ bot: juniper, key: "j-run", harness: "fake", prompt: "run forever" }));
  await inState(s, mine.snapshot.task.id, "running");
  await s.h.run(s.h.daemon.deleteBot(juniper));
  await until("Juniper's tasks to go", async () => (await s.h.run(s.h.store.tasks.task(mine.snapshot.task.id))) === undefined);
  assert.equal(s.fake.sessions[0]!.closed, true);

  const atlasTask = await s.h.run(s.tasks.start({ bot: atlas, key: "a-run", harness: "fake", prompt: "run forever" }));
  await inState(s, atlasTask.snapshot.task.id, "running");
  await s.h.run(s.h.daemon.stop(atlas));
  assert.equal((await ended(s, atlasTask.snapshot.task.id)).state, "cancelled");
});

test("the bot drives it with its tools, and the transcript links the call to its task", async () => {
  const s = await setup();
  await s.h.run(s.h.daemon.submit(s.h.bot, "go", 'call collar__task_start {"harness": "fake", "prompt": "fix it"}', "followUp", null));
  const entry = await until("the tool result", async () => (await s.h.entries()).find((e) => e.kind === "tool" && e.message.toolName === "collar__task_start"));
  const wire = toWire(entry) as { task?: string; text: string };
  assert.match(wire.task!, /^task_\w{10}$/);
  const result = JSON.parse(textOfContent((entry as Extract<StoredEntry, { kind: "tool" }>).message.content)) as { started: { id: string; state: string } };
  assert.equal(result.started.id, wire.task);
  assert.equal((await ended(s, wire.task!)).state, "completed");
  const views = await s.h.run(s.tasks.views);
  assert.equal(views.find((v) => v.id === wire.task)?.state, "completed");
});

type Controlled = { adapter: FakeHarness; emit: () => (event: HarnessEvent) => void; interrupts: () => number };

function controlled(options: { interrupt?: "hang" | "end" } = {}): Controlled {
  const base = fakeHarness({ stepMs: 10 });
  let emit: (event: HarnessEvent) => void = () => {};
  let interrupts = 0;
  const adapter: FakeHarness = {
    ...base,
    open: async (_spec, e) => {
      emit = e;
      e({ type: "session", externalId: "ctl-1" });
      return {
        run: async () => {},
        steer: async () => {},
        interrupt: () => {
          interrupts++;
          if (options.interrupt === "end") emit({ type: "turn_ended", status: "interrupted" });
          return options.interrupt === "hang" ? new Promise(() => {}) : Promise.resolve();
        },
        answer: () => {},
        close: async () => {},
      };
    },
  };
  return { adapter, emit: () => emit, interrupts: () => interrupts };
}

test("a cancel that arrives just as the turn completes keeps the answer: the task completed", async () => {
  const ctl = controlled({ interrupt: "end" });
  const s = await setup({ fake: ctl.adapter });
  const { snapshot } = await start(s, { prompt: "anything" });
  await inState(s, snapshot.task.id, "running");
  ctl.emit()({ type: "turn_ended", status: "completed", result: "The answer." });
  const cancelled = await s.h.run(s.tasks.cancel(s.h.bot, snapshot.task.id));
  assert.deepEqual([cancelled.cancelled, cancelled.task.state, cancelled.task.result], [false, "completed", "The answer."]);
});

test("a harness that never confirms an interrupt is still cancelled after the grace period", async () => {
  const ctl = controlled({ interrupt: "hang" });
  const s = await setup({ fake: ctl.adapter });
  const { snapshot } = await start(s, { prompt: "anything" });
  await inState(s, snapshot.task.id, "running");
  const began = Date.now();
  const cancelled = await s.h.run(s.tasks.cancel(s.h.bot, snapshot.task.id));
  assert.equal(cancelled.task.state, "cancelled");
  assert.equal(ctl.interrupts(), 1);
  assert.ok(Date.now() - began < 5_000, "it didn't wait on the stuck interrupt");
});

test("a task that ended without its message (a crash in between) is announced at the next start", async () => {
  const dir = mkdtempSync(join(tmpdir(), "top-tasks-notify-"));
  const first = await setup({ dir, harness: { stepMs: 10 } });
  const { snapshot } = await start(first, { prompt: "run forever" });
  await inState(first, snapshot.task.id, "running");
  await first.h.run(first.h.store.tasks.setState(snapshot.task.id, ["running"], "completed", { result: "Finished just before the crash." }));
  await first.h.close();
  const second = await setup({ dir });
  const told = await until("the late message", async () => (await notes(second)).find((n) => n.includes(snapshot.task.id)));
  assert.match(told, /completed\] .*\n\nFinished just before the crash\./s);
  assert.equal((await notes(second)).filter((n) => n.includes(snapshot.task.id)).length, 1);
});

test("events for a task that's gone (its bot was deleted) are dropped, not fatal to the log", async () => {
  const s = await setup();
  await s.h.run(s.h.store.tasks.appendEvents([{ task: "task_gone", bot: s.h.bot, at: 1, kind: "message", text: "late" }]));
  const { snapshot } = await start(s, { prompt: "quick" });
  assert.equal((await ended(s, snapshot.task.id)).state, "completed");
  assert.ok((await s.h.run(s.tasks.read(s.h.bot, snapshot.task.id, 0, 200))).events.length > 3, "logging carries on");
});
