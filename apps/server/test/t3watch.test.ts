// Top keeps watching its T3 Code sessions after their tasks end: what T3 Code does in one on its own later (a provider's
// child reporting back, a restart continuing a run) reaches the bot once, as a task that continues the one before.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { afterAll, test } from "vitest";
import { textOf } from "../src/messages.ts";
import type { StoredEntry } from "../src/store.ts";
import type { StartRequest, Tasks } from "../src/tasks/coordinator.ts";
import type { TaskRow } from "../src/tasks/store.ts";
import { writeT3Config } from "../src/tasks/t3api.ts";
import { T3CODE, t3codeAdapter } from "../src/tasks/t3code.ts";
import { owners } from "../src/tasks/t3owner.ts";
import { type FakeT3, fakeT3 } from "./fixtures/fake-t3.ts";
import { type Harness, harness, until } from "./harness.ts";

const servers: FakeT3[] = [];
afterAll(async () => {
  for (const server of servers) await server.close();
});

type Setup = { h: Harness; t3: FakeT3; tasks: Tasks; file: string; dir: string };

const pair = (file: string, t3: FakeT3) =>
  writeT3Config(file, { url: t3.origin, token: t3.token(), environmentId: "env-1", label: "fake", serverVersion: "0.0.0-fake", connectedAt: "now" });

async function setup(options: { dir?: string; t3?: FakeT3; maxTasks?: number } = {}): Promise<Setup> {
  const t3 = options.t3 ?? (await fakeT3());
  if (!options.t3) servers.push(t3);
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), "top-t3watch-"));
  mkdirSync(join(dir, "bots", "Atlas"), { recursive: true });
  const file = join(dir, "t3code.json");
  if (!options.dir) await pair(file, t3);
  const h = await harness({
    dir,
    harnesses: [t3codeAdapter({ file, reconnectForMs: 3_000, replyMs: 1_000, settleMs: 200 })],
    context: true,
    taskCancelGraceMs: 2_000,
    gatherMs: 20,
    ...(options.maxTasks ? { maxTasks: options.maxTasks } : {}),
  });
  await h.run(h.daemon.start);
  return { h, t3, tasks: h.daemon.tasks!, file, dir };
}

let keys = 0;
const start = (s: Setup, request: Partial<StartRequest> & { prompt: string }) =>
  s.h
    .run(s.tasks.start({ bot: s.h.bot, key: `key-${++keys}`, ...(request.session ? {} : { harness: T3CODE, cwd: "/srv/app" }), ...request }))
    .then((r) => r.snapshot);
const task = (s: Setup, id: string) => s.h.run(s.h.store.tasks.task(id)).then((t) => t!);
const ended = (s: Setup, id: string) =>
  until(`task ${id} to end`, async () => {
    const t = await task(s, id);
    return ["completed", "failed", "cancelled"].includes(t.state) && t;
  });
const runIn = (s: Setup, thread: string) => until(`a running run in ${thread}`, () => s.t3.runsOf(thread).find((r) => r.status === "running"));
const log = async (s: Setup, id: string) => (await s.h.run(s.tasks.read(s.h.bot, id, 0, 200))).events.map((e) => e.text);
const settle = (ms = 400) => new Promise((resolve) => setTimeout(resolve, ms));
/** Every task in the session, oldest first. */
const tasksOf = async (s: Setup, session: string): Promise<TaskRow[]> =>
  (await s.h.run(s.h.store.tasks.tasksOf(s.h.bot, 200))).filter((t) => t.session === session).reverse();
const continuations = async (s: Setup, session: string) => (await tasksOf(s, session)).filter((t) => t.continues);
const told = async (s: Setup, id: string) => {
  const entries = (await s.h.entries()).filter((e): e is Extract<StoredEntry, { kind: "user" }> => e.kind === "user" && e.source === "task");
  const inbox = (await s.h.run(s.h.store.inbox(s.h.bot))).filter((r) => r.source === "task").map((r) => r.text);
  return [...entries.map((e) => textOf(e.message.content)), ...inbox].filter((text) => text.includes(`[Task ${id}`));
};
const continuation = async (s: Setup, session: string, n = 1) => {
  await until(`${n} continuation(s) in ${session}`, async () => (await continuations(s, session)).length >= n);
  const found = (await continuations(s, session))[n - 1]!;
  return ended(s, found.id);
};
const person = { createdBy: "user", creationSource: "web" };
/** A provider's own child of `runId` ending, and T3 Code waking the owner for it `later` (a run's message that names the child). */
const nativeWake = (child: string, extra: Record<string, unknown> = {}) => ({
  createdBy: "agent",
  notification: { source: { kind: "subagent", childThreadId: `native-${child}` }, outcome: "completed", summary: "A child finished." },
  ...extra,
});

/** A task whose run ends while a provider's own child still works, which T3 Code can't show: the task completes. */
const interimThenChild = async (s: Setup, child: string, session?: string) => {
  const first = await start(s, { prompt: "run forever", ...(session ? { session } : {}) });
  const thread = `top-${first.session.id}`;
  const run = await until("the task's run", () => s.t3.runsOf(thread).find((r) => r.userMessageId === `top:${first.task.id}` && r.status === "running"));
  s.t3.nativeChildDone(thread, String(run.id), child);
  s.t3.finish(thread, String(run.id), "the interim answer");
  const done = await ended(s, first.task.id);
  assert.equal(done.result, "the interim answer");
  return { first, thread, run };
};

test("a provider's child that reports back after the task ended reaches the bot once, as a task continuing it, however late", async () => {
  const s = await setup();
  const { first, thread } = await interimThenChild(s, "c1");
  await settle(200);
  const wake = s.t3.wake(thread, "wake-1", "the child's report", nativeWake("c1"));
  const c = await continuation(s, first.session.id);
  assert.equal(c.state, "completed", c.error ?? "");
  assert.equal(c.result, "done: the child's report");
  assert.equal(c.continues, first.task.id);
  assert.equal(c.adopt, wake);
  assert.equal(c.key, `t3:${thread}:${wake}`);
  await until("the bot to hear", async () => (await told(s, c.id)).length > 0);
  const heard = await told(s, c.id);
  assert.match(heard[0]!, new RegExp(`continuing task ${first.task.id}`));
  assert.ok(!s.t3.requests.some((r) => r.payload.type === "message.dispatch" && r.payload.threadId === thread), "nothing was sent to follow it");

  // An hour of T3 Code's time later, a chained second wake: the continuation's own child.
  s.t3.nativeChildDone(thread, wake, "c2");
  s.t3.advance(3_600_000);
  s.t3.wake(thread, "wake-2", "the second report", nativeWake("c2"));
  const c2 = await continuation(s, first.session.id, 2);
  assert.equal(c2.result, "done: the second report");
  assert.equal(c2.continues, c.id, "it continues the continuation whose run its child came from");
  await settle();
  assert.equal((await continuations(s, first.session.id)).length, 2);
  assert.equal((await told(s, c.id)).length, 1, "the bot heard each once");
  assert.equal((await told(s, c2.id)).length, 1);
});

test("a wake T3 Code loses changes nothing and holds nothing; a monitor's progress is never reported", async () => {
  const s = await setup();
  const { first, thread } = await interimThenChild(s, "lost");
  s.t3.advance(3 * 3_600_000);
  s.t3.wake(thread, "monitor-1", "a monitor's progress", {
    createdBy: "agent",
    notification: { source: { kind: "monitor" }, outcome: "updated", summary: "s" },
  });
  await until("the monitor's run to end", () => s.t3.runsOf(thread).find((r) => r.userMessageId === "monitor-1" && r.status === "completed"));
  await settle(800);
  assert.equal((await continuations(s, first.session.id)).length, 0);
  assert.equal((await task(s, first.task.id)).state, "completed");
});

test("a wake that comes and ends while Top's connection to T3 Code is down is reported when it's back, once, from replayed or duplicated changes", async () => {
  const s = await setup();
  const { first, thread } = await interimThenChild(s, "c1");
  await settle(300);
  const before = s.t3.shellRequests().length;
  s.t3.faults.dropOnOpen = true;
  s.t3.dropSockets();
  const wake = s.t3.wake(thread, "wake-1", "reported while Top was away", nativeWake("c1"));
  await until("the wake to end", () => s.t3.runsOf(thread).find((r) => r.id === wake && r.status === "completed"));
  s.t3.faults.shellDuplicate = true;
  s.t3.faults.dropOnOpen = false;
  const c = await continuation(s, first.session.id);
  assert.equal(c.result, "done: reported while Top was away");
  const resumed = s.t3.shellRequests().slice(before).at(-1)!.payload;
  assert.equal(typeof resumed.afterSequence, "number", "the watch picked up from where it left off");

  // A watch T3 Code can't resume gets a whole snapshot, which repeats what Top already accounted for.
  s.t3.faults.shellForget = true;
  s.t3.dropSockets();
  await until("the watch to come back", () => s.t3.shellRequests().length > before + 1);
  await settle(800);
  assert.equal((await continuations(s, first.session.id)).length, 1, "no run was reported twice");
});

test("Top restarting between a task's end and the wake, or with a continuation saved but not started, reports the wake once", async () => {
  const first = await setup();
  const { first: t, thread } = await interimThenChild(first, "c1");
  await first.h.close();
  first.t3.wake(thread, "wake-1", "reported while Top was down", nativeWake("c1"));
  const second = await setup({ dir: first.dir, t3: first.t3 });
  const c = await continuation(second, t.session.id);
  assert.equal(c.result, "done: reported while Top was down");
  await until("the bot to hear", async () => (await told(second, c.id)).length > 0);

  // A continuation saved just before Top stopped, never started: picked up after the restart, and still one.
  second.t3.nativeChildDone(thread, String(c.adopt), "c2");
  const late = second.t3.wake(thread, "wake-2", "forever: the second wake", nativeWake("c2"));
  await until("the second continuation to be saved", async () => (await continuations(second, t.session.id)).length === 2);
  await second.h.close();
  const third = await setup({ dir: first.dir, t3: first.t3 });
  third.t3.finish(thread, late, "the second wake's answer");
  const c2 = await continuation(third, t.session.id, 2);
  assert.equal(c2.result, "the second wake's answer");
  await until("the bot to hear", async () => (await told(third, c2.id)).length > 0);
  await settle();
  assert.equal((await continuations(third, t.session.id)).length, 2);
  assert.equal((await told(third, c.id)).length, 1, "a restart doesn't tell the bot again");
  assert.equal((await told(third, c2.id)).length, 1);
});

/** Edits Top's database while it's stopped, as a crash would have left it. */
const edit = async (dir: string, statements: string) => {
  const { DatabaseSync } = await import("node:sqlite");
  const raw = new DatabaseSync(join(dir, "top.sqlite"));
  raw.exec(statements);
  raw.close();
};

test("a task's end and its account are saved together, and an end Top crashed before telling the bot of is told once", async () => {
  const s = await setup();
  const { first, run } = await interimThenChild(s, "c1");
  const accounted = await s.h.run(s.h.store.tasks.runsOf(first.session.id));
  assert.deepEqual(accounted.get(String(run.id)), { task: first.task.id, kind: "reported" });
  await until("the bot to hear", async () => (await told(s, first.task.id)).length > 0);
  await s.h.close();
  // As if Top had stopped after saving the end and before saving the notice.
  const request = `task:${first.task.id}:completed`;
  await edit(
    s.dir,
    `UPDATE tasks SET notified = NULL WHERE id = '${first.task.id}'; DELETE FROM inbox WHERE request_id = '${request}'; DELETE FROM entries WHERE request_id = '${request}';`,
  );
  const second = await setup({ dir: s.dir, t3: s.t3 });
  await until("the bot to hear again", async () => (await told(second, first.task.id)).length > 0);
  await second.h.close();
  const third = await setup({ dir: s.dir, t3: s.t3 });
  await settle();
  assert.equal((await told(third, first.task.id)).length, 1, "told once, though Top restarted twice");
});

test("a person's turns in T3 Code and what they cause stay theirs; Top's own child's wake is still reported", async () => {
  const s = await setup();
  const { first, thread } = await interimThenChild(s, "c1");
  // Someone writes in the thread in T3 Code and delegates there; their child reports back to them.
  const human = s.t3.wake(thread, "human-1", "delegate the person's work", person);
  await until("their run to end", () => s.t3.runsOf(thread).find((r) => r.id === human && r.status === "completed"));
  s.t3.childDone(thread, `task-${human}`, "the person's child report");
  await until("their wake to end", () => s.t3.runsOf(thread).find((r) => r.userMessageId === `delegated:task-${human}` && r.status === "completed"));
  // A wake that names nothing, now that a person writes there too.
  s.t3.wake(thread, "unlinked-1", "an unlinked wake");
  // And Top's own child reporting back.
  s.t3.wake(thread, "wake-1", "Top's child report", nativeWake("c1"));
  const c = await continuation(s, first.session.id);
  assert.equal(c.result, "done: Top's child report");
  await settle(800);
  const all = await continuations(s, first.session.id);
  assert.equal(all.length, 1, "only Top's work was reported");
  for (const t of await tasksOf(s, first.session.id)) {
    const texts = [t.result ?? "", ...(await log(s, t.id))].join("\n");
    assert.doesNotMatch(texts, /person's|unlinked wake/, "nothing of theirs reached the bot");
  }
  assert.ok(
    (await log(s, first.task.id)).some((t) => /nothing linking it to Top's work/.test(t)),
    "the unlinked wake is noted, without its text",
  );
});

test("a restart continuation of the task's run is reported; a continuation's question reaches the bot and its answer T3 Code", async () => {
  const s = await setup();
  const { first, thread, run } = await interimThenChild(s, "unused");
  s.t3.wake(thread, "restart-1", "a question after the restart", { createdBy: "system" }, { restartContinuationOfRunId: String(run.id) });
  const asking = await until("a continuation", async () => (await continuations(s, first.session.id))[0]);
  await until("it to ask", async () => (await task(s, asking.id)).state === "waiting_for_input");
  const input = (await s.h.run(s.tasks.snapshot(s.h.bot, asking.id))).inputs[0]!;
  await s.h.run(s.tasks.respond("bot", s.h.bot, asking.id, input.id, { answers: { q1: ["Red"] } }));
  const done = await ended(s, asking.id);
  assert.equal(done.result, 'answer: {"color":"red"}');

  // A continuation is cancelled like any task: its run is stopped in T3 Code, and nothing reports it after.
  const again = s.t3.wake(thread, "restart-2", "forever: another continuation", { createdBy: "system" }, { restartContinuationOfRunId: String(run.id) });
  const going = await until("the second continuation", async () => (await continuations(s, first.session.id))[1]);
  await until("its run", () => s.t3.runsOf(thread).find((r) => r.id === again && r.status === "running"));
  await until("it to run", async () => (await task(s, going.id)).state === "running");
  const stopped = await s.h.run(s.tasks.cancel(s.h.bot, going.id));
  assert.equal(stopped.task.state, "cancelled");
  assert.equal(s.t3.runsOf(thread).find((r) => r.id === again)!.status, "interrupted");
  await settle(800);
  assert.equal((await continuations(s, first.session.id)).length, 2);
});

test("a never-ending child holds its task without an execution slot, and a cancel ends it with nothing reported after", async () => {
  const s = await setup({ maxTasks: 1 });
  const holding = await start(s, { prompt: "delegate the long work" });
  const thread = `top-${holding.session.id}`;
  await until("it to wait on its child", async () => (await log(s, holding.task.id)).some((t) => /still has delegated work/.test(t)));
  await until("its slot to be freed", async () => (await log(s, holding.task.id)).some((t) => /execution slot is free/.test(t)));
  // With one slot, another task still runs.
  const other = await start(s, { prompt: "plain other" });
  assert.equal((await ended(s, other.task.id)).result, "done: plain other");
  const cancelled = await s.h.run(s.tasks.cancel(s.h.bot, holding.task.id));
  assert.equal(cancelled.task.state, "cancelled");
  // Whatever T3 Code still does for the cancelled work isn't reported.
  s.t3.wake(thread, "late", "a late wake", { createdBy: "agent", delegatedCompletion: { parentRunId: `run:${thread}:1`, generation: 1, taskIds: [] } });
  await until("the late run to end", () => s.t3.runsOf(thread).find((r) => r.userMessageId === "late" && r.status === "completed"));
  await settle(800);
  assert.equal((await continuations(s, holding.session.id)).length, 0);
});

test("a bot's new task racing a wake: the wake is reported once, by whichever got the session first", async () => {
  const s = await setup();
  const { first, thread } = await interimThenChild(s, "c1");
  const wake = s.t3.wake(thread, "wake-1", "forever: the racing wake", nativeWake("c1"));
  const raced = await s.h.run(Effect.result(s.tasks.start({ bot: s.h.bot, key: `key-${++keys}`, session: first.session.id, prompt: "plain next" })));
  await runIn(s, thread);
  s.t3.finish(thread, wake, "the racing wake's answer");
  await until("the session to settle", async () => (await tasksOf(s, first.session.id)).every((t) => ["completed", "failed", "cancelled"].includes(t.state)));
  await settle(800);
  const all = await tasksOf(s, first.session.id);
  const reporting = all.filter((t) => t.result === "the racing wake's answer" || t.adopt === wake);
  if (raced._tag === "Success") {
    // The new task got there first: the wake ran as part of it, and no continuation reports it again.
    assert.equal((await continuations(s, first.session.id)).length, 0);
    assert.ok(
      (await log(s, raced.success.snapshot.task.id)).some((t) => t.includes("the racing wake's answer")),
      "the wake's work shows in the task it joined",
    );
  } else {
    assert.match((raced.failure as { message: string }).message, /busy with task/);
    assert.equal(reporting.length, 1, "the continuation got there first and reports it");
  }
  assert.ok(reporting.length <= 1);
});

test("an archived thread isn't looked at until it's back; a T3 Code Top isn't paired with anymore is picked up again once it is", async () => {
  const s = await setup();
  const { first, thread } = await interimThenChild(s, "c1");
  s.t3.archive(thread, true);
  await settle(300);
  const looks = () => s.t3.hits.filter((h) => h.path === `/api/orchestration/threads/${encodeURIComponent(thread)}`).length;
  const before = looks();
  // A wake on the archived thread (T3 Code doesn't send them there, but if one ran): no look, no task, while it's archived.
  s.t3.wake(thread, "wake-1", "after the thread came back", nativeWake("c1"));
  await until("the wake to end", () => s.t3.runsOf(thread).find((r) => r.userMessageId === "wake-1" && r.status === "completed"));
  await settle(500);
  assert.equal(looks(), before, "an archived thread gets no look");
  assert.equal((await continuations(s, first.session.id)).length, 0);
  // Back in T3 Code's list: Top catches up with it.
  s.t3.archive(thread, false);
  const c = await continuation(s, first.session.id);
  assert.equal(c.result, "done: after the thread came back");

  // Unpaired: the watch keeps trying and fails nothing; paired again, it catches up. (A look already under way finishes.)
  await settle(800);
  rmSync(s.file);
  s.t3.dropSockets();
  s.t3.nativeChildDone(thread, String(c.adopt), "c2");
  s.t3.wake(thread, "wake-2", "while Top wasn't paired", nativeWake("c2"));
  await settle(800);
  assert.equal((await continuations(s, first.session.id)).length, 1);
  await pair(s.file, s.t3);
  const c2 = await continuation(s, first.session.id, 2);
  assert.equal(c2.result, "done: while Top wasn't paired");
});

test("sessions from before Top kept this account start from what T3 Code shows then, and report only what comes after", async () => {
  const s = await setup();
  const { first, thread, run } = await interimThenChild(s, "c1");
  await s.h.close();
  // As if an earlier Top had run this session: no account of its runs, and a wake it never saw.
  await edit(s.dir, `DELETE FROM harness_runs WHERE session = '${first.session.id}';`);
  const old = s.t3.wake(thread, "old-1", "an old wake from before", nativeWake("c1"));
  await until("the old wake to end", () => s.t3.runsOf(thread).find((r) => r.id === old && r.status === "completed"));
  const second = await setup({ dir: s.dir, t3: s.t3 });
  await until("the baseline", async () => (await second.h.run(second.h.store.tasks.runsOf(first.session.id))).get(old)?.kind === "baseline");
  await settle(500);
  assert.equal((await continuations(second, first.session.id)).length, 0, "history isn't reported again");
  second.t3.nativeChildDone(thread, String(run.id), "c3");
  second.t3.wake(thread, "new-1", "a new wake", nativeWake("c3"));
  const c = await continuation(second, first.session.id);
  assert.equal(c.result, "done: a new wake");
});

test("whose work a run is follows T3 Code's own links, and an unlinked wake is Top's only if nobody else wrote before it", () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 10, 20, 12, minute)).toISOString();
  const run = (id: string, message: string, minute: number, extra: Record<string, unknown> = {}) =>
    [id, { id, userMessageId: message, requestedAt: at(minute), ...extra }] as const;
  const message = (id: string, minute: number, extra: Record<string, unknown> = {}) => [id, { id, role: "user", createdAt: at(minute), ...extra }] as const;
  const records = {
    runs: new Map([
      run("r1", "top:task_a", 1),
      run("r2", "m-dc", 2),
      run("r3", "m-pr", 3),
      run("r4", "m-mcp", 4),
      run("r5", "m-late", 5),
      run("r6", "m-person", 6),
      run("r7", "m-their-dc", 7),
      run("r8", "m-restart", 8, { restartContinuationOfRunId: "r1" }),
      run("r9", "m-native", 9),
      run("r10", "m-progress", 10),
      run("r11", "m-loop", 11),
    ]),
    messages: new Map([
      message("top:task_a", 1, { createdBy: "user", creationSource: "web" }),
      message("m-dc", 2, { createdBy: "agent", delegatedCompletion: { parentRunId: "r1" } }),
      message("m-pr", 3, { createdBy: "agent", notification: { source: { kind: "monitor" }, outcome: "completed" } }),
      message("m-mcp", 4, { createdBy: "agent", creationSource: "mcp", senderThreadId: "elsewhere" }),
      message("m-late", 5, { createdBy: "agent", notification: { source: { kind: "command" }, outcome: "completed" } }),
      message("m-person", 6, { createdBy: "user", creationSource: "web" }),
      message("m-their-dc", 7, { createdBy: "agent", delegatedCompletion: { parentRunId: "r6" } }),
      message("m-restart", 8, { createdBy: "system" }),
      message("m-native", 9, { createdBy: "agent", notification: { source: { kind: "subagent", childThreadId: "child-1" }, outcome: "completed" } }),
      message("m-progress", 10, { createdBy: "agent", notification: { source: { kind: "monitor" }, outcome: "updated" } }),
      message("m-loop", 11, { createdBy: "agent", delegatedCompletion: { parentRunId: "r11" } }),
    ]),
    subagents: new Map([["s1", { id: "s1", runId: "r2", childThreadId: "child-1" }]]),
  };
  const ownerOf = owners(records, new Map([["r2", { task: "task_c", kind: "adopted" }]]));
  assert.deepEqual(ownerOf("r1"), { kind: "top", key: "task_a" });
  assert.deepEqual(ownerOf("r2"), { kind: "top", task: "task_c" }, "a run a task took leads to that task");
  assert.deepEqual(ownerOf("r3"), { kind: "top" }, "an unlinked wake before anyone else wrote is Top's");
  assert.deepEqual(ownerOf("r4"), { kind: "human" }, "another agent's message through MCP is someone else's");
  assert.deepEqual(ownerOf("r5"), { kind: "unknown" }, "an unlinked wake after someone else wrote can't be proven Top's");
  assert.deepEqual(ownerOf("r6"), { kind: "human" });
  assert.deepEqual(ownerOf("r7"), { kind: "human" }, "what a person's turn causes is theirs");
  assert.deepEqual(ownerOf("r8"), { kind: "top", key: "task_a" }, "a restart continues the run it restarts");
  assert.deepEqual(ownerOf("r9"), { kind: "top", task: "task_c" }, "a provider's child reports to the run that started it");
  assert.deepEqual(ownerOf("r10"), { kind: "monitor" });
  assert.deepEqual(ownerOf("r11"), { kind: "unknown" }, "a chain that loops proves nothing");
});
