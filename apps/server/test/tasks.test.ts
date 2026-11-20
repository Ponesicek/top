import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@top/protocol";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import { test } from "vitest";
import { WebSocket } from "ws";
import { textOf as textOfContent } from "../src/messages.ts";
import { HIDDEN } from "../src/secrets.ts";
import type { StoredEntry } from "../src/store.ts";
import { codexCloudAdapter } from "../src/tasks/codexcloud.ts";
import type { StartRequest, Tasks } from "../src/tasks/coordinator.ts";
import { type FakeHarness, type FakeHarnessConfig, fakeHarness } from "../src/tasks/fake.ts";
import type { HarnessAdapter, HarnessEvent } from "../src/tasks/harness.ts";
import { toWire } from "../src/wire.ts";
import { botFolder } from "../src/workspace.ts";
import { type Harness, harness, until } from "./harness.ts";

type Setup = { h: Harness; fake: FakeHarness; tasks: Tasks; folder: (bot?: number) => string };

async function setup(
  options: {
    harness?: FakeHarnessConfig;
    fake?: FakeHarness;
    bots?: string[];
    maxTasks?: number;
    dir?: string;
    start?: boolean;
    cancelGraceMs?: number;
    serve?: boolean;
    extra?: HarnessAdapter[];
  } = {},
): Promise<Setup> {
  const fake = options.fake ?? fakeHarness({ stepMs: 30, ...options.harness });
  const names = options.bots ?? ["Atlas"];
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), "top-tasks-"));
  for (const name of names) mkdirSync(botFolder(join(dir, "bots"), name), { recursive: true });
  const h = await harness({
    dir,
    harnesses: [fake, ...(options.extra ?? [])],
    context: true,
    bots: names,
    maxTasks: options.maxTasks,
    taskCancelGraceMs: options.cancelGraceMs ?? 300,
    gatherMs: 20,
    ...(options.serve ? { serve: {} } : {}),
  });
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
    return ["completed", "failed", "cancelled", "handed_off"].includes(t.state) && t;
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
  assert.equal(snapshot.session.cwd, s.folder());
  const done = await ended(s, snapshot.task.id);
  assert.equal(done.state, "completed");
  assert.equal(done.result, "Done: fix the login bug");
  assert.deepEqual(done.usage, { inputTokens: 100, outputTokens: 20 });
  assert.match(done.title, /fix the login bug/);
  assert.equal(s.fake.sessions.length, 1);
  assert.equal(s.fake.sessions[0]!.closed, true, "the harness process is closed when the task ends");

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

test("questions wake the bot, which may answer; the first answer wins", async () => {
  const s = await setup();
  const { snapshot } = await start(s, { prompt: "a question please" });
  await inState(s, snapshot.task.id, "waiting_for_input");
  const [ask] = await pending(s, snapshot.task.id);
  assert.equal(ask!.title, "Which database?");
  const told = await until("the bot to hear about the question", async () => (await notes(s)).find((n) => n.includes("needs input")));
  assert.match(told, /Which database\?/);
  assert.match(told, /"request": \d+/);

  assert.match(await failure(s, s.tasks.respond("bot", s.h.bot, snapshot.task.id, ask!.id, { answers: {} })), /Answer question "db"/);
  assert.match(await failure(s, s.tasks.respond("bot", s.h.bot, snapshot.task.id, ask!.id, { answers: { db: ["a", "b"] } })), /takes one answer/);
  assert.match(await failure(s, s.tasks.respond("bot", s.h.bot, snapshot.task.id, ask!.id, { answers: { db: ["x"], zz: ["y"] } })), /has no question "zz"/);
  await s.h.run(s.tasks.respond("bot", s.h.bot, snapshot.task.id, ask!.id, { answers: { db: ["SQLite"] } }));
  assert.match(
    await failure(s, s.tasks.respond("user", undefined, snapshot.task.id, ask!.id, { answers: { db: ["Postgres"] } })),
    /already answered by the bot/,
  );
  assert.equal((await ended(s, snapshot.task.id)).result, "Using SQLite.");
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

test("a restart cuts off a started task without running it again, and starts one that was only queued", async () => {
  const dir = mkdtempSync(join(tmpdir(), "top-tasks-restart-"));
  const first = await setup({ dir });
  const running = await start(first, { prompt: "run forever" });
  await inState(first, running.snapshot.task.id, "running");
  await first.h.run(
    first.h.store.tasks.createSession({
      id: "ses_q",
      bot: first.h.bot,
      harness: "fake",

      cwd: first.folder(),
      model: null,
      options: {},
      parent: null,
    }),
  );
  await first.h.run(
    first.h.store.tasks.createTask(
      { id: "task_queued", bot: first.h.bot, key: "q-key", session: "ses_q", title: "queued", prompt: "only queued", images: [] },
      "queued",
    ),
  );
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
  assert.ok(
    second.fake.sessions.every((session) => session.turns.every((t) => t.text !== "run forever")),
    "the cut-off task wasn't run again",
  );
  const told = await until("the bot to hear it was cut off", async () => (await notes(second)).find((n) => n.includes(running.snapshot.task.id)));
  assert.match(told, /failed\]/);

  assert.equal((await ended(second, "task_queued")).state, "completed", "a task that never started runs after the restart");
  assert.equal(second.fake.sessions.length, 1);
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

test("the bot drives it with its tools, and the transcript keeps a fixed receipt of the agent it started", async () => {
  const s = await setup();
  await s.h.run(s.h.daemon.submit(s.h.bot, "go", 'call collar__task_start {"harness": "fake", "prompt": "fix it"}', "followUp", null));
  const entry = await until("the tool result", async () => (await s.h.entries()).find((e) => e.kind === "tool" && e.message.toolName === "collar__task_start"));
  const wire = toWire(entry) as { agent?: unknown; text: string };
  assert.deepEqual(wire.agent, { title: "fix it", harness: "Fake harness", cwd: s.folder() });
  const result = JSON.parse(textOfContent((entry as Extract<StoredEntry, { kind: "tool" }>).message.content)) as { started: { id: string; state: string } };
  assert.equal((await ended(s, result.started.id)).state, "completed");
  assert.deepEqual(toWire(entry), wire, "the receipt doesn't follow the task");
  assert.deepEqual(await s.h.run(s.tasks.waiting), []);
});

test("a start saved before receipts had their own details still shows one, from its result", () => {
  const started = { started: { id: "task_0123456789", title: "Fix it", harness: "codex", session: "ses_1", cwd: "/w", model: "gpt" } };
  const entry = {
    kind: "tool",
    seq: 1,
    bot: 1,
    at: 1,
    message: {
      role: "toolResult",
      toolCallId: "c",
      toolName: "collar__task_start",
      content: [{ type: "text", text: JSON.stringify(started) }],
      details: { task: "task_0123456789" },
      isError: false,
      timestamp: 1,
    },
  } as unknown as StoredEntry;
  assert.deepEqual((toWire(entry) as { agent?: unknown }).agent, { title: "Fix it", harness: "codex", cwd: "/w", model: "gpt" });
});

type Controlled = { adapter: FakeHarness; emit: () => (event: HarnessEvent) => void; interrupts: () => number; ackSteer: () => void };

function controlled(options: { interrupt?: "hang" | "end"; steer?: "hang" | "manual" } = {}): Controlled {
  let ack: () => void = () => {};
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
        steer: () =>
          options.steer === "hang"
            ? new Promise<void>(() => {})
            : options.steer === "manual"
              ? new Promise<void>((resolve) => {
                  ack = resolve;
                })
              : Promise.resolve(),
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
  return { adapter, emit: () => emit, interrupts: () => interrupts, ackSteer: () => ack() };
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

test("the app hears a task's questions come and go, and nothing else of it, even while a cancel waits on the harness", async () => {
  const ctl = controlled({ interrupt: "hang" });
  const s = await setup({ fake: ctl.adapter, cancelGraceMs: 3_000 });
  const scope = await s.h.run(Scope.make());
  const { subscription } = await s.h.run(s.h.events.subscribe.pipe(Scope.provide(scope)));
  const heard: number[] = [];
  const take = async () => {
    for (const e of await s.h.run(PubSub.takeAll(subscription))) if (e._tag === "WaitingTasks") heard.push(e.tasks.length);
    return heard;
  };
  const { snapshot } = await start(s, { prompt: "anything" });
  await inState(s, snapshot.task.id, "running");
  ctl.emit()({ type: "log", kind: "message", text: "working on it" });
  ctl.emit()({ type: "request", request: { id: "q1", title: "Which?", questions: [{ id: "a", question: "Which?", options: [] }] } });
  await until("the question to reach the app", async () => (await take()).length === 1);
  assert.equal((await s.h.run(s.tasks.waiting)).length, 1, "a client connecting now starts from what the others were sent");
  await new Promise((r) => setTimeout(r, 400));
  const cancelling = s.h.run(s.tasks.cancel(s.h.bot, snapshot.task.id));
  await until("the withdrawn question to leave the app before the stuck stop gives up", async () => (await take()).length === 2, 1_000);
  assert.deepEqual(heard, [1, 0]);
  assert.deepEqual(await s.h.run(s.tasks.waiting), []);
  assert.equal((await cancelling).task.state, "cancelled");
  await s.h.run(Scope.close(scope, Exit.void));
});

test("an app is sent the questions waiting now, never a stale list carried by an event, such as one replayed from before it connected", async () => {
  const s = await setup({ serve: true });
  const frames: { t: string; tasks?: { id: string }[] }[] = [];
  const socket = new WebSocket(`ws://127.0.0.1:${s.h.port}`, { origin: "file://" });
  socket.on("message", (data) => frames.push(JSON.parse(String(data))));
  await new Promise((resolve) => socket.on("open", resolve));
  socket.send(JSON.stringify({ t: "hello", clientId: "replay", protocol: PROTOCOL_VERSION }));
  const waitingFrames = () => frames.filter((f) => f.t === "waitingTasks").map((f) => f.tasks!.map((t) => t.id));
  await until("the first list", () => waitingFrames().length === 1);
  // What a replayed event looks like: a question that was already answered by the time the app connected.
  const answered = { id: "task_0123456789", bot: s.h.bot, title: "Old", inputs: [{ id: 1, title: "Which?", questions: [] }] };
  await s.h.run(s.h.events.publish({ _tag: "WaitingTasks", tasks: [answered] }));
  const { snapshot } = await start(s, { prompt: "a question" });
  await until("the live question", () => waitingFrames().some((ids) => ids.includes(snapshot.task.id)));
  assert.deepEqual(waitingFrames(), [[], [snapshot.task.id]], "the stale list was never sent");
  await s.h.run(s.tasks.cancel(s.h.bot, snapshot.task.id));
  socket.close();
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

test("a cancel while the harness is still being checked never opens it", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const base = fakeHarness({ stepMs: 10 });
  const slow: FakeHarness = {
    ...base,
    check: async () => {
      await gate;
      return { ok: true, version: "1" };
    },
  };
  const s = await setup({ fake: slow });
  const { snapshot } = await start(s, { prompt: "do work" });
  await inState(s, snapshot.task.id, "starting");
  const cancelled = await s.h.run(s.tasks.cancel(s.h.bot, snapshot.task.id));
  release();
  assert.equal(cancelled.task.state, "cancelled");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(base.sessions.length, 0);
});

test("a message queued as the turn completes either runs or is refused, never left behind", async () => {
  const ctl = controlled();
  const s = await setup({ fake: ctl.adapter });
  const { snapshot } = await start(s, { prompt: "anything" });
  await inState(s, snapshot.task.id, "running");
  ctl.emit()({ type: "turn_ended", status: "completed", result: "first" });
  const sent = await s.h.run(Effect.result(s.tasks.send(s.h.bot, snapshot.task.id, "late", "queue", "one more")));
  if (sent._tag === "Success") {
    await until("the queued turn", async () => (await s.h.run(s.h.store.tasks.messageByKey("late")))?.state === "sent");
    ctl.emit()({ type: "turn_ended", status: "completed", result: "second" });
    assert.equal((await ended(s, snapshot.task.id)).result, "second");
  } else {
    assert.match(sent.failure.message, /is ending|has ended/);
    assert.equal((await ended(s, snapshot.task.id)).result, "first");
  }
  assert.deepEqual(await s.h.run(s.h.store.tasks.pendingMessages(snapshot.task.id)), []);
});

test("a steer the harness never confirms doesn't hold up a cancel", async () => {
  const ctl = controlled({ interrupt: "end", steer: "hang" });
  const s = await setup({ fake: ctl.adapter });
  const { snapshot } = await start(s, { prompt: "anything" });
  await inState(s, snapshot.task.id, "running");
  const steering = s.h.run(Effect.result(s.tasks.send(s.h.bot, snapshot.task.id, "stuck", "steer", "change course")));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const began = Date.now();
  const cancelled = await s.h.run(s.tasks.cancel(s.h.bot, snapshot.task.id));
  assert.equal(cancelled.task.state, "cancelled");
  assert.ok(Date.now() - began < 2_000, "cancel didn't wait for the steer");
  const steered = await steering;
  assert.equal(
    steered._tag === "Failure" && steered.failure.message,
    "The task ended before the harness took the message.",
    "the waiting send is answered, not left to time out",
  );
});

test("a waiter that gets a question isn't sent the question as a message too", async () => {
  const s = await setup({ harness: { stepMs: 60 } });
  const { snapshot } = await start(s, { prompt: "a question" });
  const waited = await s.h.run(s.tasks.wait(s.h.bot, snapshot.task.id, 5_000, "input_or_end"));
  assert.equal(waited.snapshot.task.state, "waiting_for_input");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(
    (await notes(s)).filter((n) => n.includes("needs input")),
    [],
  );
});

test("a task_wait cut off by a restart is recovered with one look, never by waiting again", async () => {
  const s = await setup();
  const { snapshot } = await start(s, { prompt: "run forever" });
  await inState(s, snapshot.task.id, "running");
  const tool = s.h.daemon.toolsOf(s.h.bot).find((t) => t.name === "collar__task_wait")!;
  assert.equal(tool.replay, undefined, "not replayed: a replay would wait at startup");
  const began = Date.now();
  const recovered = await s.h.run(tool.recover!({ id: snapshot.task.id, until: "end" }, { key: "k", bot: s.h.bot }));
  assert.ok(Date.now() - began < 1_000);
  assert.match(JSON.stringify(recovered), /\\"timedOut\\":true/);
  await s.h.run(s.tasks.cancel(s.h.bot, snapshot.task.id));
});

test("a steer let in just as the task completes is answered at once, not left to time out", async () => {
  const ctl = controlled();
  const s = await setup({ fake: ctl.adapter });
  const { snapshot } = await start(s, { prompt: "anything" });
  await inState(s, snapshot.task.id, "running");
  ctl.emit()({ type: "turn_ended", status: "completed", result: "done" });
  const began = Date.now();
  const sent = await s.h.run(Effect.result(s.tasks.send(s.h.bot, snapshot.task.id, "late-steer", "steer", "one more thing")));
  assert.ok(Date.now() - began < 2_000);
  if (sent._tag === "Failure") assert.match(sent.failure.message, /ended|No turn is running|is ending/);
});

test("an acknowledgment that arrives after the task was cancelled isn't logged as a steer", async () => {
  const ctl = controlled({ interrupt: "end", steer: "manual" });
  const s = await setup({ fake: ctl.adapter });
  const { snapshot } = await start(s, { prompt: "anything" });
  await inState(s, snapshot.task.id, "running");
  const steering = s.h.run(Effect.result(s.tasks.send(s.h.bot, snapshot.task.id, "slow-steer", "steer", "change course")));
  await new Promise((resolve) => setTimeout(resolve, 50));
  await s.h.run(s.tasks.cancel(s.h.bot, snapshot.task.id));
  ctl.ackSteer();
  const steered = await steering;
  assert.equal(steered._tag, "Failure");
  await new Promise((resolve) => setTimeout(resolve, 300));
  const read = await s.h.run(s.tasks.read(s.h.bot, snapshot.task.id, 0, 200));
  assert.ok(!read.events.some((e) => e.text.startsWith("steered")), "no steer is claimed for a dropped message");
  assert.equal((await s.h.run(s.h.store.tasks.messageByKey("slow-steer")))?.state, "dropped");
});

test("however an acknowledgment and a cancel interleave, what the bot is told matches the message and the log", async () => {
  for (const delay of [0, 1, 2, 5, 10, 20]) {
    const ctl = controlled({ interrupt: "end", steer: "manual" });
    const s = await setup({ fake: ctl.adapter });
    const { snapshot } = await start(s, { prompt: "anything" });
    await inState(s, snapshot.task.id, "running");
    const key = `steer-${delay}`;
    const steering = s.h.run(Effect.result(s.tasks.send(s.h.bot, snapshot.task.id, key, "steer", "change course")));
    await until("the steer to reach the harness", async () => (await s.h.run(s.h.store.tasks.messageByKey(key))) !== undefined);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const cancelling = s.h.run(s.tasks.cancel(s.h.bot, snapshot.task.id));
    setTimeout(() => ctl.ackSteer(), delay);
    await cancelling;
    const sent = await steering;
    const message = await s.h.run(s.h.store.tasks.messageByKey(key));
    const read = await s.h.run(s.tasks.read(s.h.bot, snapshot.task.id, 0, 200));
    const logged = read.events.some((e) => e.text.startsWith("steered"));
    if (sent._tag === "Success") assert.deepEqual([message?.state, logged], ["sent", true], `delay ${delay}`);
    else assert.deepEqual([message?.state, logged], ["dropped", false], `delay ${delay}`);
    await s.h.close();
  }
});

test("a saved secret a harness echoes is hidden from the task's log, questions, result and the bot's messages", async () => {
  const ctl = controlled();
  const s = await setup({ fake: ctl.adapter });
  const value = "tok_echoed_by_harness_7Kq2";
  await s.h.run(s.h.secrets.save(s.h.bot, value));
  const { snapshot } = await start(s, { prompt: "deploy with the saved token" });
  await inState(s, snapshot.task.id, "running");
  ctl.emit()({ type: "log", kind: "message", text: `using ${value}` });
  ctl.emit()({
    type: "request",
    request: {
      id: "q",
      title: `Use ${value}?`,
      questions: [{ id: "q1", question: `Is ${value} right?`, header: value, options: [{ label: value, description: value }, { label: "No" }] }],
    },
  });
  await inState(s, snapshot.task.id, "waiting_for_input");
  const [input] = await pending(s, snapshot.task.id);
  assert.ok(input && !JSON.stringify(input).includes(value), "the stored question never holds the secret");
  assert.deepEqual(
    input.questions[0]?.options.map((o) => o.label),
    ["No"],
    "an option that would show the secret is left out; the answer can still be typed",
  );
  ctl.emit()({ type: "turn_ended", status: "completed", result: `deployed with ${value}` });
  const done = await ended(s, snapshot.task.id);
  assert.equal(done.result, `deployed with ${HIDDEN}`);
  const events = await until("the task's log", async () => {
    const rows = (await s.h.run(s.h.store.tasks.events(snapshot.task.id, 0, 200))).events;
    return rows.some((e) => e.text.includes("using")) && rows;
  });
  assert.ok(!events.some((e) => e.text.includes(value)), "the log never holds the secret");
  const told = await until("the bot to hear both", async () => {
    const all = await notes(s);
    return all.length >= 2 && all;
  });
  assert.ok(!told.some((text) => text.includes(value)), "the bot's messages never hold the secret");
  await s.h.close();
});

// ── Cloud harnesses ──

const FAKE_CODEX_CLOUD = join(import.meta.dirname, "fixtures", "fake-codex-cloud.mjs");
const cloudStart = (s: Setup, request: Partial<StartRequest> & { prompt: string }) =>
  start(s, { harness: "fake-cloud", options: { repo: "acme/app" }, ...request });

test("a cloud harness hands work off: the task ends handed_off, not completed, holds no running slot, and the bot hears where it went", async () => {
  const cloud = fakeHarness({ stepMs: 30, where: "cloud" });
  const s = await setup({ maxTasks: 1, extra: [cloud] });
  const blocker = await start(s, { prompt: "run forever" });
  await inState(s, blocker.snapshot.task.id, "running");
  const handed = await cloudStart(s, { prompt: "fix the login bug" });
  assert.equal(handed.snapshot.session.cwd, "github.com/acme/app @ main");
  const done = await ended(s, handed.snapshot.task.id);
  assert.equal(done.state, "handed_off", "it ran though the one running slot was taken");
  assert.match(done.result!, /^Sent to Fake cloud: https:\/\/example\.invalid\/fake\/1\. Top can't see its progress or result there\.$/);
  const told = await until("the bot to hear", async () => (await notes(s)).find((n) => n.includes(handed.snapshot.task.id)));
  assert.match(told, /^\[Task \S+ was handed off\] fix the login bug \(Fake cloud\), after .*\n\nSent to Fake cloud: /);
  assert.match(told, /to carry on with it, call collar__task_start with "session"/, "it can continue a session, so it's told how");
  const waited = await s.h.run(s.tasks.wait(s.h.bot, handed.snapshot.task.id, 1_000, "end"));
  assert.equal(waited.timedOut, false, "handed_off is an end");
  assert.deepEqual(await s.h.run(s.tasks.cancel(s.h.bot, handed.snapshot.task.id)).then((r) => r.cancelled), false);
  await s.h.run(s.tasks.cancel(s.h.bot, blocker.snapshot.task.id));
});

test("a cloud harness takes no cwd or model, and cancel, steer and queue are refused with nothing touched", async () => {
  const cloud = fakeHarness({ stepMs: 30, where: "cloud", capabilities: { resume: false } });
  const s = await setup({ extra: [cloud] });
  assert.match(
    await failure(s, startE(s, { harness: "fake-cloud", prompt: "x", options: { repo: "a/b" }, cwd: "/tmp" })),
    /^Fake cloud runs in its vendor's cloud and takes no `cwd`: name what it works on in its options \(repo\)\.$/,
  );
  const running = await cloudStart(s, { prompt: "run forever" });
  const id = running.snapshot.task.id;
  await inState(s, id, "running");
  assert.equal(
    await failure(s, s.tasks.cancel(s.h.bot, id)),
    `Fake cloud can't stop a task from Top: it runs in its vendor's cloud, so task ${id} goes on (running).`,
  );
  assert.match(await failure(s, s.tasks.send(s.h.bot, id, "c-s", "steer", "hi")), /Fake cloud can't take steering messages/);
  assert.match(await failure(s, s.tasks.send(s.h.bot, id, "c-q", "queue", "hi")), /Fake cloud can't take queued messages/);
  await s.h.run(s.h.daemon.stop(s.h.bot));
  await new Promise((r) => setTimeout(r, 200));
  assert.equal((await task(s, id)).state, "running", "neither a cancel nor Stop changes it");
  assert.equal(cloud.sessions[0]!.interrupted, 0, "no stop was sent");
  assert.equal(cloud.sessions[0]!.closed, false);
  assert.equal(await s.h.run(s.h.store.tasks.cancelRequested(id)), false);
  assert.deepEqual(await s.h.run(s.h.store.tasks.pendingMessages(id)), []);
  const read = await s.h.run(s.tasks.read(s.h.bot, id, 0, 50));
  assert.ok(!read.events.some((e) => /cancel/.test(e.text)), "nothing about a cancel was logged");
});

test("deleting a bot lets go of its cloud tasks without a word to the vendor", async () => {
  const cloud = fakeHarness({ stepMs: 30, where: "cloud" });
  const s = await setup({ bots: ["Atlas", "Juniper"], extra: [cloud] });
  const juniper = s.h.bots[1]!;
  const mine = await s.h.run(s.tasks.start({ bot: juniper, key: "j-cloud", harness: "fake-cloud", prompt: "run forever", options: { repo: "a/b" } }));
  await inState(s, mine.snapshot.task.id, "running");
  await s.h.run(s.h.daemon.deleteBot(juniper));
  await until("Juniper's tasks to go", async () => (await s.h.run(s.h.store.tasks.task(mine.snapshot.task.id))) === undefined);
  assert.equal(cloud.sessions[0]!.interrupted, 0, "no stop was sent to the vendor");
  assert.equal(cloud.sessions[0]!.closed, true, "Top stopped following it");
});

test("a cloud task cut off by a restart says Top can't tell whether it got there, and is never sent again", async () => {
  const dir = mkdtempSync(join(tmpdir(), "top-tasks-cloud-restart-"));
  const first = await setup({ dir, extra: [fakeHarness({ stepMs: 30, where: "cloud", capabilities: { resume: false } })] });
  const running = await cloudStart(first, { prompt: "run forever" });
  await inState(first, running.snapshot.task.id, "running");
  await first.h.close();
  const cloud = fakeHarness({ stepMs: 30, where: "cloud", capabilities: { resume: false } });
  const second = await setup({ dir, extra: [cloud] });
  const cut = await task(second, running.snapshot.task.id);
  assert.equal(cut.state, "failed");
  assert.equal(
    cut.error,
    "Cut off: the daemon restarted while it was handing the task to Fake cloud, so Top can't tell whether it got there. Check there before starting it again: Top never sends it twice.",
  );
  assert.equal(cloud.sessions.length, 0);
  const told = await until("the bot to hear", async () => (await notes(second)).find((n) => n.includes(running.snapshot.task.id)));
  assert.doesNotMatch(told, /carry on/, "it can't continue a session, so it isn't told to");
});

test("the receipt of a cloud task says it's in the cloud, with what it works on", async () => {
  const s = await setup({ extra: [fakeHarness({ stepMs: 30, where: "cloud" })] });
  await s.h.run(
    s.h.daemon.submit(
      s.h.bot,
      "go",
      'call collar__task_start {"harness": "fake-cloud", "prompt": "fix it", "options": {"repo": "acme/app"}}',
      "followUp",
      null,
    ),
  );
  const entry = await until("the tool result", async () => (await s.h.entries()).find((e) => e.kind === "tool" && e.message.toolName === "collar__task_start"));
  assert.deepEqual((toWire(entry) as { agent?: unknown }).agent, { title: "fix it", harness: "Fake cloud", cwd: "github.com/acme/app @ main", where: "cloud" });
  const result = JSON.parse(textOfContent((entry as Extract<StoredEntry, { kind: "tool" }>).message.content)) as { next: string };
  assert.match(result.next, /^Top hands it off in the background\./);
});

test("Codex cloud through Top: the marker is saved before the send, and a restart follows a known task but never resends an unsure one", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "top-cc-tasks-"));
  process.env.FAKE_CC_DIR = fixture;
  const adapter = () => codexCloudAdapter({ command: FAKE_CODEX_CLOUD, firstPollMs: 20, maxPollMs: 40, submitTimeoutMs: 3_000 });
  const execs = () =>
    readFileSync(join(fixture, "calls.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l.includes('"exec","--env"')).length;
  const externalId = (s: Setup, session: string) => s.h.run(s.h.store.tasks.session(session)).then((r) => r?.externalId);
  try {
    // Unsure: the send hangs, so Top has only its marker when it restarts.
    process.env.FAKE_CC_EXEC = "hang";
    const dir = mkdtempSync(join(tmpdir(), "top-tasks-cc-"));
    const first = await setup({ dir, extra: [adapter()] });
    const unsure = await start(first, { harness: "codex-cloud", prompt: "fix it", options: { environment: "env_fake", branch: "main" } });
    assert.equal(unsure.snapshot.session.cwd, "env_fake @ main");
    await until("the marker", async () => (await externalId(first, unsure.snapshot.session.id))?.startsWith("pending:task_"));
    await until("the send to start", () => existsSync(join(fixture, "calls.jsonl")) && execs() === 1);
    await first.h.close();
    process.env.FAKE_CC_EXEC = "ok";
    const second = await setup({ dir, extra: [adapter()] });
    const failed = await ended(second, unsure.snapshot.task.id);
    assert.equal(failed.state, "failed");
    assert.match(failed.error!, /^Top restarted while it was sending this to Codex cloud, so it may or may not have got there\./);
    assert.equal(execs(), 1, "never sent again");
    await second.h.close();

    // Known: Top restarts while following it by id, and follows it again to its end.
    process.env.FAKE_CC_STATES = "PENDING";
    const dir2 = mkdtempSync(join(tmpdir(), "top-tasks-cc2-"));
    const third = await setup({ dir: dir2, extra: [adapter()] });
    const known = await start(third, { harness: "codex-cloud", prompt: "add a test", options: { environment: "env_fake", branch: "main" } });
    await until("its id", async () => (await externalId(third, known.snapshot.session.id)) === "task_e_1");
    await third.h.close();
    process.env.FAKE_CC_STATES = "READY";
    const fourth = await setup({ dir: dir2, extra: [adapter()] });
    const done = await ended(fourth, known.snapshot.task.id);
    assert.equal(done.state, "completed");
    assert.match(done.result!, /^Codex cloud finished: Fix the login bug\n\+12\/-3 • 2 files\nhttps:\/\/chatgpt\.com\/codex\/tasks\/task_e_1\n/);
    assert.equal(execs(), 2, "one send per task");
    await fourth.h.close();
  } finally {
    delete process.env.FAKE_CC_DIR;
    delete process.env.FAKE_CC_EXEC;
    delete process.env.FAKE_CC_STATES;
  }
});

test("S7 task_cancel on a handed-off task says the work may still be going on in the cloud, not that it ended", async () => {
  const s = await setup({ extra: [fakeHarness({ stepMs: 30, where: "cloud" })] });
  const handed = await cloudStart(s, { prompt: "fix it" });
  assert.equal((await ended(s, handed.snapshot.task.id)).state, "handed_off");
  await s.h.run(s.h.daemon.submit(s.h.bot, "c", `call collar__task_cancel {"id": "${handed.snapshot.task.id}"}`, "followUp", null));
  const entry = await until("the tool result", async () =>
    (await s.h.entries()).find((e) => e.kind === "tool" && e.message.toolName === "collar__task_cancel"),
  );
  const result = JSON.parse(textOfContent((entry as Extract<StoredEntry, { kind: "tool" }>).message.content)) as {
    state: string;
    cancelled: boolean;
    note: string;
  };
  assert.deepEqual(result, {
    id: handed.snapshot.task.id,
    state: "handed_off",
    cancelled: false,
    note: "It was handed off to its vendor's cloud, where the work may still be going on: Top can't stop it there.",
  });
});
