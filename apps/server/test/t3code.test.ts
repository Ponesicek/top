import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { afterAll, test } from "vitest";
import { textOf } from "../src/messages.ts";
import type { StoredEntry } from "../src/store.ts";
import * as T3Link from "../src/t3link.ts";
import type { StartRequest, Tasks } from "../src/tasks/coordinator.ts";
import { fakeHarness } from "../src/tasks/fake.ts";
import { credentialOf, plainHttpExposed, readT3Config, t3Origin, writeT3Config } from "../src/tasks/t3api.ts";
import { itemLog, T3CODE, t3Answers, t3codeAdapter } from "../src/tasks/t3code.ts";
import { type FakeT3, fakeT3 } from "./fixtures/fake-t3.ts";
import { type Harness, harness, until } from "./harness.ts";

const servers: FakeT3[] = [];
afterAll(async () => {
  for (const server of servers) await server.close();
});

type Setup = { h: Harness; t3: FakeT3; tasks: Tasks; file: string; dir: string };

async function setup(options: { dir?: string; t3?: FakeT3 } = {}): Promise<Setup> {
  const t3 = options.t3 ?? (await fakeT3());
  if (!options.t3) servers.push(t3);
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), "top-t3-"));
  mkdirSync(join(dir, "bots", "Atlas"), { recursive: true });
  const file = join(dir, "t3code.json");
  if (!options.dir)
    await writeT3Config(file, { url: t3.origin, token: t3.token(), environmentId: "env-1", label: "fake", serverVersion: "0.0.0-fake", connectedAt: "now" });
  const h = await harness({
    dir,
    harnesses: [t3codeAdapter({ file, reconnectForMs: 3_000, replyMs: 1_000, settleMs: 200 })],
    context: true,
    taskCancelGraceMs: 2_000,
    gatherMs: 20,
  });
  await h.run(h.daemon.start);
  return { h, t3, tasks: h.daemon.tasks!, file, dir };
}

let keys = 0;
const startE = (s: Setup, request: Partial<StartRequest> & { prompt: string }) =>
  s.tasks.start({ bot: s.h.bot, key: `key-${++keys}`, ...(request.session ? {} : { harness: T3CODE, cwd: "/srv/app" }), ...request });
const start = (s: Setup, request: Partial<StartRequest> & { prompt: string }) => s.h.run(startE(s, request)).then((r) => r.snapshot);
const refusal = async (s: Setup, request: Partial<StartRequest> & { prompt: string }) => {
  const result = await s.h.run(Effect.result(startE(s, request)));
  assert.equal(result._tag, "Failure", "it should be refused");
  return (result as { failure: { message: string } }).failure.message;
};
const task = (s: Setup, id: string) => s.h.run(s.h.store.tasks.task(id)).then((t) => t!);
const ended = (s: Setup, id: string) =>
  until(`task ${id} to end`, async () => {
    const t = await task(s, id);
    return ["completed", "failed", "cancelled"].includes(t.state) && t;
  });
const inState = (s: Setup, id: string, state: string) => until(`task ${id} to be ${state}`, async () => (await task(s, id)).state === state);
const runIn = (s: Setup, thread: string) => until(`a running run in ${thread}`, () => s.t3.runsOf(thread).find((r) => r.status === "running"));
const log = async (s: Setup, id: string) => (await s.h.run(s.tasks.read(s.h.bot, id, 0, 200))).events.map((e) => e.text);
const told = async (s: Setup, id: string) => {
  const entries = (await s.h.entries()).filter((e): e is Extract<StoredEntry, { kind: "user" }> => e.kind === "user" && e.source === "task");
  const inbox = (await s.h.run(s.h.store.inbox(s.h.bot))).filter((r) => r.source === "task").map((r) => r.text);
  return [...entries.map((e) => textOf(e.message.content)), ...inbox].filter((text) => text.includes(`[Task ${id}`));
};

test("a task runs in a T3 Code project and carries on in the same thread; what T3 Code can't do is refused", async () => {
  const s = await setup();
  const first = await start(s, { prompt: "fix the login bug\nin the web app", title: "Login bug", model: "haiku" });
  assert.equal(first.session.cwd, "/srv/app");
  const done = await ended(s, first.task.id);
  assert.equal(done.state, "completed", done.error ?? "");
  assert.equal(done.result, "done: fix the login bug\nin the web app");
  const thread = `top-${first.session.id}`;
  const launch = s.t3.requests.find((r) => r.tag === "orchestration.launchThread")!.payload;
  assert.deepEqual(launch.modelSelection, { instanceId: "claudeAgent", model: "claude-haiku-5-5" }, "a model alias picks its provider");
  assert.equal(launch.runtimeMode, "full-access");
  assert.equal(launch.title, "Login bug", "the thread is named as the task, the name the conversation's card shows");
  assert.equal((await s.h.run(s.h.store.tasks.session(first.session.id)))!.externalId, thread);

  const second = await start(s, { prompt: "and the signup bug", session: first.session.id });
  assert.equal((await ended(s, second.task.id)).result, "done: and the signup bug");
  assert.equal(s.t3.runsOf(thread).length, 2, "the session's next task is a new run in the same thread");

  assert.match(await refusal(s, { prompt: "x", session: first.session.id, fork: true }), /T3 Code can't branch a session/);
  assert.match(await refusal(s, { prompt: "x", images: ["a.png"] }), /T3 Code doesn't take images/);
  assert.match(await refusal(s, { prompt: "x", cwd: "/srv/other" }), /T3 Code on fake has no project at \/srv\/other\. Its projects: \/srv\/app/);
  assert.match(await refusal(s, { prompt: "x", cwd: "app" }), /give its absolute path/);
  const unknown = await start(s, { prompt: "x", options: { provider: "cursor" } });
  assert.match((await ended(s, unknown.task.id)).error ?? "", /T3 Code has no provider "cursor" switched on\. Its providers: claudeAgent \(ready/);
  const broken = await start(s, { prompt: "x", options: { provider: "codex" } });
  assert.match((await ended(s, broken.task.id)).error ?? "", /T3 Code's codex isn't ready there \(error\)/);
  assert.match(await refusal(s, { prompt: "x", options: { effort: "high" } }), /Bad options for T3 Code/);
});

test("a reply lost with the connection is asked for again with the same command id, so the turn starts once", async () => {
  const s = await setup();
  s.t3.faults.dropReplyTo = "orchestration.launchThread";
  const first = await start(s, { prompt: "launch once" });
  assert.equal((await ended(s, first.task.id)).state, "completed");
  const launches = s.t3.requests.filter((r) => r.tag === "orchestration.launchThread");
  assert.equal(launches.length, 2, "the launch was sent again after the drop");
  assert.equal(launches[0]!.payload.commandId, launches[1]!.payload.commandId);
  assert.equal(s.t3.runsOf(`top-${first.session.id}`).length, 1, "but only one run started");

  s.t3.faults.dropReplyTo = "message.dispatch";
  const next = await start(s, { prompt: "dispatch once", session: first.session.id });
  assert.equal((await ended(s, next.task.id)).result, "done: dispatch once");
  assert.equal(s.t3.runsOf(`top-${first.session.id}`).length, 2);
});

test("a dropped connection is followed from where it left off, and an end T3 Code repeats counts once", async () => {
  const s = await setup();
  s.t3.faults.dropAfterReplyTo = "orchestration.launchThread";
  const launched = await start(s, { prompt: "dropped right after the launch" });
  assert.equal((await ended(s, launched.task.id)).result, "done: dropped right after the launch", "a drop before the first snapshot is followed through");
  assert.equal(s.t3.runsOf(`top-${launched.session.id}`).length, 1);

  s.t3.faults.duplicateEnds = true;
  const running = await start(s, { prompt: "run forever" });
  const thread = `top-${running.session.id}`;
  const run = await runIn(s, thread);
  s.t3.dropSockets();
  s.t3.finish(thread, String(run.id), "finished while Top was away");
  const done = await ended(s, running.task.id);
  assert.equal(done.state, "completed");
  assert.equal(done.result, "finished while Top was away");
  assert.ok((await log(s, running.task.id)).some((t) => t.startsWith("lost the connection to T3 Code")));
  const resumed = s.t3.requests.filter((r) => r.tag === "orchestration.subscribeThread").at(-1)!.payload;
  assert.equal(typeof resumed.afterSequence, "number", "it asked only for what it missed");
  await until("the bot to hear", async () => (await told(s, running.task.id)).length > 0);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal((await told(s, running.task.id)).length, 1, "the bot heard once");
});

test("a socket that keeps opening and dropping gives up when the reconnect window ends", async () => {
  const s = await setup();
  s.t3.faults.dropOnOpen = true;
  const flapping = await start(s, { prompt: "never gets through" });
  const done = await until(
    "the task to give up",
    async () => {
      const t = await task(s, flapping.task.id);
      return t.state === "failed" && t;
    },
    20_000,
  );
  // Whichever window ends first, the connection's or the request's: both give up the same way.
  assert.match(done.error ?? "", /(Lost T3 Code at http:\/\/127\.0\.0\.1:\d+|T3 Code didn't answer \S+) for 3s .*may still be running there/);
  assert.equal(s.t3.requests.filter((r) => r.tag === "orchestration.launchThread").length, 0);
});

test("a T3 Code that keeps the socket open but stops answering is dropped, and the task gives up after the window", async () => {
  const s = await setup();
  const running = await start(s, { prompt: "run forever" });
  await runIn(s, `top-${running.session.id}`);
  s.t3.faults.silent = true;
  s.t3.dropSockets();
  const done = await until(
    "the task to give up",
    async () => {
      const t = await task(s, running.task.id);
      return t.state === "failed" && t;
    },
    20_000,
  );
  assert.match(done.error ?? "", /Lost T3 Code at .* for 3s .*may still be running there/);
});

test("a command T3 Code never answers gives up after the window, even while the thread's stream keeps catching up", async () => {
  const s = await setup();
  const first = await start(s, { prompt: "first" });
  assert.equal((await ended(s, first.task.id)).state, "completed");
  s.t3.faults.silentTypes.add("message.dispatch");
  const next = await start(s, { prompt: "never answered", session: first.session.id });
  const done = await until(
    "the task to give up",
    async () => {
      const t = await task(s, next.task.id);
      return t.state === "failed" && t;
    },
    20_000,
  );
  assert.match(done.error ?? "", /T3 Code didn't answer orchestration\.dispatchCommand for 3s/);
  const sent = s.t3.requests.filter((r) => r.payload.type === "message.dispatch");
  assert.ok(sent.length >= 2 && sent.every((r) => r.payload.commandId === sent[0]!.payload.commandId), "every retry carried the same command id");
});

test("questions reach the bot and the user, and the answer goes back as the option's value", async () => {
  assert.deepEqual(
    t3Answers(
      {
        questions: [
          { id: "Which colour, given the key sk-live-1234567890abcdef?", options: [{ label: "Red", value: "red" }] },
          { id: "b", multiSelect: true, options: [{ label: "X" }] },
        ],
      },
      { q1: ["Red"], q2: ["X", "own words"] },
    ),
    { "Which colour, given the key sk-live-1234567890abcdef?": "red", b: ["X", "own words"] },
    "Top's numbered answers go back under T3 Code's own question ids",
  );
  const s = await setup();
  const asking = await start(s, { prompt: "a question" });
  await inState(s, asking.task.id, "waiting_for_input");
  const snapshot = await s.h.run(s.tasks.snapshot(s.h.bot, asking.task.id));
  const input = snapshot.inputs[0]!;
  assert.equal(input.questions[0]!.id, "q1", "Top's own question id, never the provider's text");
  assert.deepEqual(
    input.questions[0]!.options.map((o) => o.label),
    ["Red", "Blue"],
  );
  await s.h.run(s.tasks.respond("user", undefined, asking.task.id, input.id, { answers: { q1: ["Red"] } }));
  const done = await ended(s, asking.task.id);
  assert.equal(done.result, 'answer: {"color":"red"}');
});

test("steer goes into the task's run and queue runs after it; cancel stops only that run; a stop in T3 Code ends the task", async () => {
  const s = await setup();
  const other = await start(s, { prompt: "someone else's forever" });
  const otherThread = `top-${other.session.id}`;
  await runIn(s, otherThread);

  const running = await start(s, { prompt: "work forever" });
  const thread = `top-${running.session.id}`;
  const run = await runIn(s, thread);
  await inState(s, running.task.id, "running");
  await s.h.run(s.tasks.send(s.h.bot, running.task.id, "steer-1", "steer", "use tabs"));
  const steer = s.t3.requests.find((r) => r.payload.type === "message.dispatch" && (r.payload.dispatchMode as { type: string }).type === "steer_active")!;
  assert.deepEqual(steer.payload.dispatchMode, { type: "steer_active", targetRunId: run.id });
  await s.h.run(s.tasks.send(s.h.bot, running.task.id, "queue-1", "queue", "then write tests"));
  s.t3.finish(thread, String(run.id), "first part");
  const done = await ended(s, running.task.id);
  assert.equal(done.result, "done: then write tests", "the queued message ran as the next turn, and the task ended after it");

  const cancelling = await start(s, { prompt: "forever again" });
  const cancelThread = `top-${cancelling.session.id}`;
  await runIn(s, cancelThread);
  await inState(s, cancelling.task.id, "running");
  const cancelled = await s.h.run(s.tasks.cancel(s.h.bot, cancelling.task.id));
  assert.equal(cancelled.task.state, "cancelled");
  assert.equal(s.t3.runsOf(cancelThread)[0]!.status, "interrupted");
  assert.equal(s.t3.runsOf(otherThread)[0]!.status, "running", "unrelated work kept running");

  s.t3.faults.configDelayMs = 300;
  const early = await start(s, { prompt: "cancelled while Top still picks the model" });
  await inState(s, early.task.id, "running");
  const launchesBefore = s.t3.requests.filter((r) => r.tag === "orchestration.launchThread").length;
  const stoppedEarly = await s.h.run(s.tasks.cancel(s.h.bot, early.task.id));
  assert.equal(stoppedEarly.task.state, "cancelled");
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(s.t3.requests.filter((r) => r.tag === "orchestration.launchThread").length, launchesBefore, "nothing was launched after the stop");
  assert.equal(stoppedEarly.task.error, null, "a stop that came first needs no warning");

  const remote = await start(s, { prompt: "forever, stopped over there" });
  const remoteThread = `top-${remote.session.id}`;
  const remoteRun = await runIn(s, remoteThread);
  await inState(s, remote.task.id, "running");
  s.t3.finish(remoteThread, String(remoteRun.id), "", "interrupted");
  const stopped = await ended(s, remote.task.id);
  assert.equal(stopped.state, "failed");
  assert.match(stopped.error ?? "", /The turn was stopped in T3 Code/);
  assert.equal(s.t3.runsOf(otherThread)[0]!.status, "running");
});

test("a revoked credential, a different environment at the address, a mismatched protocol and no connection are clear", async () => {
  const s = await setup();
  const running = await start(s, { prompt: "forever" });
  await runIn(s, `top-${running.session.id}`);
  s.t3.revoke();
  s.t3.dropSockets();
  const cut = await ended(s, running.task.id);
  assert.equal(cut.state, "failed");
  assert.match(cut.error ?? "", /no longer accepts Top's credential.*top t3code connect/);
  const check = await t3codeAdapter({ file: s.file }).check();
  assert.match(check.ok ? "" : check.error, /no longer accepts Top's credential/);

  s.t3.rotate("good-token");
  s.t3.setEnvironment("env-2");
  const moved = await t3codeAdapter({ file: s.file }).check();
  assert.match(moved.ok ? "" : moved.error, /answers as a different T3 Code environment .* so Top didn't send it the credential/);
  const before = s.t3.hits.length;
  assert.match(await refusal(s, { prompt: "x" }), /answers as a different T3 Code environment/);
  assert.ok(
    s.t3.hits.slice(before).every((hit) => !hit.authorized),
    "starting a task there sent no credential, not even to list projects",
  );

  const proxy = createServer((_req, res) => {
    res.writeHead(502);
    res.end();
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const proxyFile = join(s.dir, "proxy.json");
  await writeT3Config(proxyFile, {
    url: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`,
    token: "good-token",
    environmentId: "env-2",
    label: "p",
    serverVersion: "",
    connectedAt: "",
  });
  const behindProxy = await t3codeAdapter({ file: proxyFile }).check();
  assert.match(behindProxy.ok ? "" : behindProxy.error, /isn't answering behind its proxy \(HTTP 502\)/);
  proxy.close();

  const redirecting = createServer((_req, res) => {
    res.writeHead(307, { location: `${s.t3.origin}/.well-known/t3/environment` });
    res.end();
  });
  await new Promise<void>((resolve) => redirecting.listen(0, "127.0.0.1", resolve));
  const redirectFile = join(s.dir, "redirect.json");
  const redirectOrigin = `http://127.0.0.1:${(redirecting.address() as AddressInfo).port}`;
  await writeT3Config(redirectFile, { url: redirectOrigin, token: "good-token", environmentId: "env-2", label: "r", serverVersion: "", connectedAt: "" });
  const redirected = await t3codeAdapter({ file: redirectFile }).check();
  assert.match(redirected.ok ? "" : redirected.error, /redirects elsewhere \(HTTP 307\)/, "a redirect is never followed");
  redirecting.close();

  const old = await fakeT3({ protocol: 1 });
  servers.push(old);
  const oldFile = join(s.dir, "old.json");
  await writeT3Config(oldFile, { url: old.origin, token: "good-token", environmentId: "", label: "old", serverVersion: "", connectedAt: "" });
  const oldCheck = await t3codeAdapter({ file: oldFile }).check();
  assert.match(oldCheck.ok ? "" : oldCheck.error, /speaks orchestration protocol 1; Top speaks 2\. Update T3 Code there/);

  const none = await t3codeAdapter({ file: join(s.dir, "missing.json") }).check();
  assert.match(none.ok ? "" : none.error, /T3 Code isn't connected to Top.*top t3code connect/);
});

test("Top restarting while T3 Code works follows the task again, sends nothing twice and still takes an answer", async () => {
  const first = await setup();
  const running = await start(first, { prompt: "run forever" });
  const thread = `top-${running.session.id}`;
  const run = await runIn(first, thread);
  await inState(first, running.task.id, "running");
  const asking = await start(first, { prompt: "a question" });
  await inState(first, asking.task.id, "waiting_for_input");
  await first.h.close();
  const sent = first.t3.requests.length;

  const second = await setup({ dir: first.dir, t3: first.t3 });
  await until("the task to be followed again", async () => (await log(second, running.task.id)).includes("following it again after Top restarted"));
  const after = second.t3.requests.slice(sent);
  assert.ok(!after.some((r) => r.tag === "orchestration.launchThread" || r.payload.type === "message.dispatch"), "nothing was sent again");
  second.t3.finish(thread, String(run.id), "done after the restart");
  const done = await ended(second, running.task.id);
  assert.equal(done.state, "completed");
  assert.equal(done.result, "done after the restart");
  assert.equal(second.t3.runsOf(thread).length, 1);

  const input = (await second.h.run(second.tasks.snapshot(second.h.bot, asking.task.id))).inputs[0]!;
  await second.h.run(second.tasks.respond("user", undefined, asking.task.id, input.id, { answers: { q1: ["Blue"] } }));
  assert.equal((await ended(second, asking.task.id)).result, 'answer: {"color":"Blue"}');
});

test("an answer saved just before Top restarted is delivered after it, and the task goes back to work", async () => {
  const first = await setup();
  const asking = await start(first, { prompt: "a question" });
  await inState(first, asking.task.id, "waiting_for_input");
  const input = (await first.h.run(first.tasks.snapshot(first.h.bot, asking.task.id))).inputs[0]!;
  await first.h.close();
  // As if Top crashed right after saving the answer, before sending it.
  const store = await harness({ dir: first.dir, context: true });
  await store.run(store.store.tasks.answerInput(input.id, { answers: { q1: ["Red"] } }, "user"));
  await store.close();

  const second = await setup({ dir: first.dir, t3: first.t3 });
  const done = await ended(second, asking.task.id);
  assert.equal(done.result, 'answer: {"color":"red"}');
});

test("an answer T3 Code refuses opens the request again, and a new answer goes through", async () => {
  const s = await setup();
  s.t3.faults.refuseAnswer = "blue";
  const asking = await start(s, { prompt: "a question" });
  await inState(s, asking.task.id, "waiting_for_input");
  const input = (await s.h.run(s.tasks.snapshot(s.h.bot, asking.task.id))).inputs[0]!;
  const refused = await s.h.run(Effect.result(s.tasks.respond("bot", s.h.bot, asking.task.id, input.id, { answers: { q1: ["blue"] } })));
  assert.equal(refused._tag, "Failure");
  assert.match(
    (refused as { failure: { message: string } }).failure.message,
    /T3 Code didn't take the answer to request \d+: "blue" isn't an answer this takes\. The request is waiting again/,
  );
  await inState(s, asking.task.id, "waiting_for_input");
  const again = (await s.h.run(s.tasks.snapshot(s.h.bot, asking.task.id))).inputs[0]!;
  assert.equal(again.id, input.id, "the same request waits again");
  await s.h.run(s.tasks.respond("bot", s.h.bot, asking.task.id, input.id, { answers: { q1: ["Red"] } }));
  assert.equal((await ended(s, asking.task.id)).result, 'answer: {"color":"red"}');
  const ids = s.t3.requests.filter((r) => r.payload.type === "runtime-request.respond").map((r) => r.payload.commandId);
  assert.equal(new Set(ids).size, 2, "a new answer is a new command, not the refused one replayed");
});

test("an answer given in T3 Code while Top's is on its way wins, and Top's late refusal reopens nothing", async () => {
  const s = await setup();
  const asking = await start(s, { prompt: "a question" });
  await inState(s, asking.task.id, "waiting_for_input");
  const input = (await s.h.run(s.tasks.snapshot(s.h.bot, asking.task.id))).inputs[0]!;
  s.t3.faults.respondDelayMs = 300;
  const answering = s.h.run(Effect.result(s.tasks.respond("bot", s.h.bot, asking.task.id, input.id, { answers: { q1: ["Red"] } })));
  await new Promise((resolve) => setTimeout(resolve, 50));
  // Answered over there; the run carries on, so Top's refusal lands while the turn is still going.
  const thread = `top-${asking.session.id}`;
  const runId = s.t3.answerThere(thread, undefined);
  await answering;
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.notEqual((await s.h.run(s.h.store.tasks.inputsOf(asking.task.id)))[0]!.state, "pending", "nothing waits again in Top");
  assert.equal((await task(s, asking.task.id)).state, "running");
  s.t3.finish(thread, runId, "answered over there");
  assert.equal((await ended(s, asking.task.id)).result, "answered over there");
});

test("an answer T3 Code never confirms while it still waits opens the request again", async () => {
  const s = await setup();
  const asking = await start(s, { prompt: "a question" });
  await inState(s, asking.task.id, "waiting_for_input");
  const input = (await s.h.run(s.tasks.snapshot(s.h.bot, asking.task.id))).inputs[0]!;
  s.t3.faults.silentTypes.add("runtime-request.respond");
  const unconfirmed = await s.h.run(Effect.result(s.tasks.respond("bot", s.h.bot, asking.task.id, input.id, { answers: { q1: ["Red"] } })));
  assert.equal(unconfirmed._tag, "Failure");
  assert.match(
    (unconfirmed as { failure: { message: string } }).failure.message,
    /didn't take the answer .*didn't answer orchestration\.dispatchCommand for 3s/,
  );
  await inState(s, asking.task.id, "waiting_for_input");
  s.t3.faults.silentTypes.clear();
  await s.h.run(s.tasks.respond("bot", s.h.bot, asking.task.id, input.id, { answers: { q1: ["Blue"] } }));
  assert.equal((await ended(s, asking.task.id)).result, 'answer: {"color":"Blue"}');
});

test("cancelling a task Top is just picking up again after a restart still stops it in T3 Code", async () => {
  const first = await setup();
  const running = await start(first, { prompt: "run forever" });
  const thread = `top-${running.session.id}`;
  await runIn(first, thread);
  await inState(first, running.task.id, "running");
  await first.h.close();
  const second = await setup({ dir: first.dir, t3: first.t3 });
  const cancelled = await second.h.run(second.tasks.cancel(second.h.bot, running.task.id));
  assert.equal(cancelled.task.state, "cancelled");
  assert.equal(second.t3.runsOf(thread)[0]!.status, "interrupted", "T3 Code's run was stopped, not just Top's record");
});

test("the cancel marker outlives pruning of a busy task's events", async () => {
  const s = await setup();
  await s.h.run(s.h.store.tasks.createSession({ id: "ses_p", bot: s.h.bot, harness: T3CODE, cwd: "/srv/app", model: null, options: {}, parent: null }));
  await s.h.run(s.h.store.tasks.createTask({ id: "task_p", bot: s.h.bot, key: "kp", session: "ses_p", title: "p", prompt: "p", images: [] }, "running"));
  await s.h.run(s.h.store.tasks.appendEvents([{ task: "task_p", bot: s.h.bot, at: 1, kind: "state", text: "cancelling" }]));
  await s.h.run(
    s.h.store.tasks.appendEvents(Array.from({ length: 30 }, (_, i) => ({ task: "task_p", bot: s.h.bot, at: i + 2, kind: "message" as const, text: `m${i}` }))),
  );
  await s.h.run(s.h.store.tasks.pruneEvents("task_p", 5));
  assert.equal(await s.h.run(s.h.store.tasks.cancelRequested("task_p")), true);
});

test("a session stays with the T3 Code environment it started on, even after Top is paired with another", async () => {
  const first = await setup();
  const running = await start(first, { prompt: "run forever" });
  await runIn(first, `top-${running.session.id}`);
  assert.equal((await first.h.run(first.h.store.tasks.session(running.session.id)))!.options.environment, "env-1");
  await first.h.close();
  const launches = first.t3.requests.filter((r) => r.tag === "orchestration.launchThread").length;
  // Paired with another environment that has a project at the same path.
  first.t3.setEnvironment("env-2");
  await writeT3Config(first.file, {
    url: first.t3.origin,
    token: first.t3.token(),
    environmentId: "env-2",
    label: "other",
    serverVersion: "",
    connectedAt: "",
  });
  const second = await setup({ dir: first.dir, t3: first.t3 });
  const cut = await ended(second, running.task.id);
  assert.equal(cut.state, "failed");
  assert.match(cut.error ?? "", /belongs to the T3 Code environment it started on \(env-1\).*nothing was sent there/);
  assert.equal(second.t3.requests.filter((r) => r.tag === "orchestration.launchThread").length, launches, "nothing was launched on the other one");
});

test("a cancel Top started before it restarted is carried out after it: the run is stopped, and a turn never sent stays unsent", async () => {
  const first = await setup();
  const running = await start(first, { prompt: "run forever" });
  const thread = `top-${running.session.id}`;
  await runIn(first, thread);
  await inState(first, running.task.id, "running");
  first.t3.faults.silentTypes.add("run.interrupt");
  void first.h.run(first.tasks.cancel(first.h.bot, running.task.id)).catch(() => {});
  await until("the cancel to be saved", () => first.h.run(first.h.store.tasks.cancelRequested(running.task.id)));

  first.t3.faults.configDelayMs = 5_000;
  const unsent = await start(first, { prompt: "never sent" });
  await inState(first, unsent.task.id, "running");
  void first.h.run(first.tasks.cancel(first.h.bot, unsent.task.id)).catch(() => {});
  await until("the second cancel to be saved", () => first.h.run(first.h.store.tasks.cancelRequested(unsent.task.id)));
  await first.h.close();
  first.t3.faults.silentTypes.clear();
  first.t3.faults.configDelayMs = 0;
  const launches = first.t3.requests.filter((r) => r.tag === "orchestration.launchThread").length;

  const second = await setup({ dir: first.dir, t3: first.t3 });
  const stopped = await ended(second, running.task.id);
  assert.equal(stopped.state, "cancelled");
  assert.equal(second.t3.runsOf(thread)[0]!.status, "interrupted", "T3 Code's run was stopped after the restart");
  const never = await ended(second, unsent.task.id);
  assert.equal(never.state, "cancelled");
  assert.equal(second.t3.requests.filter((r) => r.tag === "orchestration.launchThread").length, launches, "the unsent turn was never launched");
  assert.equal(second.t3.runsOf(`top-${unsent.session.id}`).length, 0);
});

const held = (s: Setup, id: string) =>
  until(`task ${id} to wait on delegated work`, async () => (await log(s, id)).some((t) => /still has delegated work/.test(t)));
const settle = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms));

test("a run that ends while its delegated task works keeps the task going until T3 Code wakes it, and the owner's answer arrives once", async () => {
  const s = await setup();
  const running = await start(s, { prompt: "delegate the review" });
  const thread = `top-${running.session.id}`;
  await held(s, running.task.id);
  await settle();
  const waiting = await task(s, running.task.id);
  assert.equal(waiting.state, "running", "the run's end isn't the task's: its child still works");
  assert.equal((await told(s, running.task.id)).length, 0, "the bot hears nothing yet");
  const subscribed = s.t3.requests.filter((r) => r.tag === "orchestration.subscribeThread").length;

  s.t3.childDone(thread, `task-run:${thread}:1`, "the review found two bugs");
  const done = await ended(s, running.task.id);
  assert.equal(done.state, "completed", done.error ?? "");
  assert.equal(done.result, "done: the review found two bugs", "the woken owner's answer, not the first run's");
  assert.equal(s.t3.runsOf(thread).length, 2);
  assert.equal(s.t3.requests.filter((r) => r.tag === "orchestration.subscribeThread").length, subscribed, "followed on the same stream throughout");
  await until("the bot to hear", async () => (await told(s, running.task.id)).length > 0);
  await settle();
  assert.equal((await told(s, running.task.id)).length, 1, "the bot heard once");
});

test("delegated work from an earlier run, and a child the woken owner delegates in turn, both hold the task", async () => {
  const s = await setup();
  const first = await start(s, { prompt: "plain first" });
  assert.equal((await ended(s, first.task.id)).result, "done: plain first");
  const thread = `top-${first.session.id}`;
  // Delegated in T3 Code after Top's turn ended, from that earlier run.
  s.t3.delegate(thread, `run:${thread}:1`, "older");

  const second = await start(s, { prompt: "plain second", session: first.session.id });
  await held(s, second.task.id);
  // The woken owner delegates again, and ends before that child does.
  s.t3.childDone(thread, "older", "delegate the follow-up");
  await until("the nested child to start", () => s.t3.subagentsOf(thread).some((t) => t.id === `task-run:${thread}:3` && t.status === "running"));
  await until("the woken run to end", () => s.t3.runsOf(thread)[2]?.status === "completed");
  await settle();
  assert.equal((await task(s, second.task.id)).state, "running", "the nested child still holds it");

  s.t3.childDone(thread, `task-run:${thread}:3`, "all settled");
  const done = await ended(s, second.task.id);
  assert.equal(done.state, "completed", done.error ?? "");
  assert.equal(done.result, "done: all settled");
});

test("background work holds the task, a monitor's progress update doesn't become its answer, and with nothing delegated a run's end is the task's", async () => {
  const s = await setup();
  const running = await start(s, { prompt: "run forever" });
  const thread = `top-${running.session.id}`;
  const run = await runIn(s, thread);
  s.t3.background(thread, [{ taskId: "bg-1", kind: "background_task" }]);
  s.t3.finish(thread, String(run.id), "started it in the background");
  await held(s, running.task.id);
  s.t3.wake(thread, "monitor-1", "forever: a monitor's progress", { notification: { source: { kind: "monitor" }, outcome: "updated" } });
  const monitorRun = await until("the monitor's run", () => s.t3.runsOf(thread).find((r) => r.userMessageId === "monitor-1" && r.status === "running"));
  const steer = await s.h.run(Effect.result(s.tasks.send(s.h.bot, running.task.id, "steer-monitor", "steer", "use tabs")));
  assert.equal(steer._tag, "Failure", "a monitor's progress run isn't the task's to steer");
  s.t3.finish(thread, String(monitorRun.id), "nothing new yet");
  await settle();
  assert.equal((await task(s, running.task.id)).state, "running", "the background work still holds it");
  s.t3.background(thread, []);
  const done = await ended(s, running.task.id);
  assert.equal(done.state, "completed", done.error ?? "");
  assert.equal(done.result, "started it in the background", "the monitor's acknowledgement isn't the task's answer");

  // A command or monitor nobody awaits, like a dev server, holds nothing.
  const served = await start(s, { prompt: "run forever", session: running.session.id });
  const servedRun = await runIn(s, thread);
  s.t3.background(thread, [{ taskId: "dev", kind: "command" }]);
  s.t3.finish(thread, String(servedRun.id), "the server is up");
  assert.equal((await ended(s, served.task.id)).result, "the server is up");

  const failing = await start(s, { prompt: "run forever", session: running.session.id });
  const failingRun = await runIn(s, thread);
  s.t3.finish(thread, String(failingRun.id), "", "failed");
  const failed = await ended(s, failing.task.id);
  assert.equal(failed.state, "failed");
  assert.match(failed.error ?? "", /T3 Code's run ended as failed/);
});

test("waiting on delegated work survives a dropped connection and Top restarting, and the answer still arrives once", async () => {
  const s = await setup();
  const dropped = await start(s, { prompt: "delegate across a drop" });
  const thread = `top-${dropped.session.id}`;
  await held(s, dropped.task.id);
  s.t3.dropSockets();
  s.t3.childDone(thread, `task-run:${thread}:1`, "done while Top was reconnecting");
  const done = await ended(s, dropped.task.id);
  assert.equal(done.result, "done: done while Top was reconnecting");

  const restarted = await start(s, { prompt: "delegate across a restart" });
  const other = `top-${restarted.session.id}`;
  await held(s, restarted.task.id);
  await s.h.close();
  const sent = s.t3.requests.length;
  s.t3.childDone(other, `task-run:${other}:1`, "done while Top was down");
  await until("the owner to answer", () => s.t3.runsOf(other)[1]?.status === "completed");

  const second = await setup({ dir: s.dir, t3: s.t3 });
  const after = await ended(second, restarted.task.id);
  assert.equal(after.state, "completed", after.error ?? "");
  assert.equal(after.result, "done: done while Top was down");
  assert.ok(
    !second.t3.requests.slice(sent).some((r) => r.tag === "orchestration.launchThread" || r.payload.type === "message.dispatch"),
    "nothing was sent again",
  );
  await until("the bot to hear", async () => (await told(second, restarted.task.id)).length > 0);
  await settle();
  assert.equal((await told(second, restarted.task.id)).length, 1, "the bot heard once");
});

test("while a task waits on delegated work, a cancel stops the thread's work and nothing completes it later; a steer is refused and a queued message runs after", async () => {
  const s = await setup();
  const cancelling = await start(s, { prompt: "delegate then cancel" });
  const thread = `top-${cancelling.session.id}`;
  await held(s, cancelling.task.id);
  const cancelled = await s.h.run(s.tasks.cancel(s.h.bot, cancelling.task.id));
  assert.equal(cancelled.task.state, "cancelled");
  assert.ok(
    s.t3.requests.some((r) => r.payload.type === "thread.stop" && r.payload.threadId === thread),
    "the thread's delegated work was stopped too",
  );
  assert.equal(s.t3.subagentsOf(thread)[0]!.status, "cancelled");
  // A wake T3 Code had already on its way changes nothing in Top.
  s.t3.wake(thread, "late", "a late answer");
  await until("the late run to end", () => s.t3.runsOf(thread)[1]?.status === "completed");
  await settle();
  const after = await task(s, cancelling.task.id);
  assert.equal(after.state, "cancelled");
  assert.equal(after.result, null);

  const queued = await start(s, { prompt: "delegate then queue" });
  const queuedThread = `top-${queued.session.id}`;
  await held(s, queued.task.id);
  const steer = await s.h.run(Effect.result(s.tasks.send(s.h.bot, queued.task.id, "steer-held", "steer", "use tabs")));
  const said = steer._tag === "Failure" ? (steer.failure as { message: string }).message : String((steer as { success: unknown }).success);
  assert.match(said, /delegated work/, "a steer with no run to take it says why");
  await s.h.run(s.tasks.send(s.h.bot, queued.task.id, "queue-held", "queue", "then write tests"));
  await settle();
  assert.equal(s.t3.runsOf(queuedThread).length, 1, "the queued message waits for the delegated work");
  s.t3.childDone(queuedThread, `task-run:${queuedThread}:1`, "child finished");
  const done = await ended(s, queued.task.id);
  assert.equal(done.result, "done: then write tests", "the queued message ran after the owner's answer, and the task ended after it");
});

test("a run T3 Code wakes the task with takes its steering, an unconfirmed stop never reads as stopped, and a cancel carried over a restart stays a cancel", async () => {
  const s = await setup();
  const steered = await start(s, { prompt: "delegate then steer" });
  const thread = `top-${steered.session.id}`;
  await held(s, steered.task.id);
  s.t3.childDone(thread, `task-run:${thread}:1`, "forever: the owner works on the result");
  const woken = await until("the woken run", () => s.t3.runsOf(thread).find((r) => r.ordinal === 2 && r.status === "running"));
  await s.h.run(s.tasks.send(s.h.bot, steered.task.id, "steer-woken", "steer", "use tabs"));
  const steer = s.t3.requests.findLast((r) => r.payload.type === "message.dispatch" && (r.payload.dispatchMode as { type: string }).type === "steer_active")!;
  assert.deepEqual(steer.payload.dispatchMode, { type: "steer_active", targetRunId: woken.id });
  s.t3.finish(thread, String(woken.id), "steered answer");
  assert.equal((await ended(s, steered.task.id)).result, "steered answer");

  s.t3.faults.silentTypes.add("thread.stop");
  const unconfirmed = await start(s, { prompt: "delegate then a stop T3 Code never answers" });
  const quiet = `top-${unconfirmed.session.id}`;
  await held(s, unconfirmed.task.id);
  const cancelled = await s.h.run(s.tasks.cancel(s.h.bot, unconfirmed.task.id));
  assert.equal(cancelled.task.state, "cancelled");
  assert.match(cancelled.task.error ?? "", /didn't confirm the stop/, "an unconfirmed stop says so");
  assert.equal(s.t3.subagentsOf(quiet)[0]!.status, "running");

  // A cancel saved before Top restarted, carried out in T3 Code while Top was down: still a cancel, never the first run's answer.
  const carried = await start(s, { prompt: "delegate then restart" });
  const other = `top-${carried.session.id}`;
  await held(s, carried.task.id);
  void s.h.run(s.tasks.cancel(s.h.bot, carried.task.id)).catch(() => {});
  await until("the cancel to be saved", () => s.h.run(s.h.store.tasks.cancelRequested(carried.task.id)));
  await s.h.close();
  s.t3.faults.silentTypes.clear();
  s.t3.stop(other);
  const second = await setup({ dir: s.dir, t3: s.t3 });
  const after = await ended(second, carried.task.id);
  assert.equal(after.state, "cancelled");
  assert.equal(after.result, null);
});

test("T3 Code's command output and prompts reach Top whole, so its secret-hiding sees a secret before anything is clipped", () => {
  const secret = "s3cr3t-value-that-straddles-a-cut";
  const output = `${"x".repeat(590)}${secret}${"y".repeat(500)}`;
  const log = itemLog({ type: "command_execution", status: "completed", input: "env", output, exitCode: 0 });
  assert.ok(log?.text.includes(secret), "nothing cut inside the secret before the coordinator scrubs and clips");
});

test("addresses are explicit, and plain HTTP is accepted only where it stays private", () => {
  assert.equal(t3Origin(" https://box.tail1.ts.net/some/path "), "https://box.tail1.ts.net");
  assert.throws(() => t3Origin("box.tail1.ts.net"), /isn't an address/);
  assert.throws(() => t3Origin("ftp://box"), /https:\/\/ or http:\/\//);
  assert.throws(() => t3Origin("https://me:secret@box"), /Leave the sign-in out/);
  assert.equal(plainHttpExposed("http://127.0.0.1:3773"), false);
  assert.equal(plainHttpExposed("http://[::1]:3773"), false);
  assert.equal(plainHttpExposed("http://127.evil.example:3773"), true, "a name that starts like loopback isn't loopback");
  assert.equal(plainHttpExposed("http://100.101.102.103:3773"), true, "a tailnet address takes --plain-http too");
  assert.equal(plainHttpExposed("http://box.tail1.ts.net:3773"), true);
  assert.equal(plainHttpExposed("http://192.168.1.4:3773"), true);
  assert.equal(plainHttpExposed("https://192.168.1.4"), false);
  assert.equal(credentialOf("https://box.ts.net/pair#token=abc123"), "abc123");
  assert.equal(credentialOf("  abc123\n"), "abc123");
});

test("the credential file is written for its owner only", async () => {
  const dir = mkdtempSync(join(tmpdir(), "top-t3-file-"));
  const file = join(dir, "server", "t3code.json");
  await writeT3Config(file, { url: "https://x.ts.net", token: "t", environmentId: "e", label: "x", serverVersion: "1", connectedAt: "now" });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal((await readT3Config(file))?.token, "t");
  writeFileSync(file, '{"url": "https://x.ts.net", "token": "s3cr3t-token-value" oops');
  await assert.rejects(readT3Config(file), (error: Error) => /isn't valid JSON/.test(error.message) && !error.message.includes("s3cr3t"));
  writeFileSync(file, "{}");
  await assert.rejects(readT3Config(file), /missing its address or credential/);
});

const linked = <A, E>(file: string, use: (link: T3Link.T3Link["Service"]) => Effect.Effect<A, E>) =>
  Effect.runPromise(Effect.flatMap(Effect.service(T3Link.T3Link), use).pipe(Effect.provide(T3Link.layer(file))));
const linkFailure = async <A, E>(file: string, use: (link: T3Link.T3Link["Service"]) => Effect.Effect<A, E>) => {
  const result = await linked(file, (link) => Effect.result(use(link)));
  assert.equal(result._tag, "Failure", "it should be refused");
  return (result as { failure: { message: string } }).failure.message;
};

test("Settings pairs with a code or link, checks the connection and forgets it; the credential never comes back", async () => {
  const t3 = await fakeT3();
  servers.push(t3);
  const file = join(mkdtempSync(join(tmpdir(), "top-t3-link-")), "server", "t3code.json");
  assert.deepEqual(await linked(file, (link) => link.view), {}, "not connected");

  const connected = await linked(file, (link) => link.connect(` ${t3.origin}/ `, `${t3.origin}/pair#token=${t3.pairingCode()}`, false));
  assert.equal(connected.url, t3.origin);
  assert.equal(connected.label, "fake");
  assert.equal(connected.error, undefined);
  assert.deepEqual(
    connected.projects?.map((p) => p.path),
    ["/srv/app"],
  );
  assert.equal(connected.providers?.[0]?.id, "claudeAgent");
  assert.equal(connected.providers?.[0]?.defaultModel, "claude-opus-5-5");
  assert.deepEqual(t3.exchanges, [{ scope: "orchestration:read orchestration:operate", label: "Top" }], "Top asks for its own, narrowed session");
  assert.equal((await readT3Config(file))?.token, t3.token());
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(connected).includes(t3.token()), "the view never carries the credential");
  assert.deepEqual(await linked(file, (link) => link.view), connected, "checking again finds the same");

  // A spent code changes nothing; nor does plain HTTP to another computer, refused before anything is sent.
  assert.match(await linkFailure(file, (link) => link.connect(t3.origin, "PAIRSPENT", false)), /didn't take that code/);
  t3.faults.echoPairing = true;
  const echoed = await linkFailure(file, (link) => link.connect(t3.origin, "PAIRSPENT", false));
  assert.ok(!echoed.includes("PAIRSPENT") && echoed.includes("[hidden]"), `a code T3 Code quotes back doesn't reach the app: ${echoed}`);
  t3.faults.echoPairing = false;
  assert.match(
    await linkFailure(file, (link) => link.connect("http://192.168.1.4:3773", t3.pairingCode(), false)),
    /plain HTTP to another computer.*switch on "Allow plain HTTP"/,
  );
  assert.equal(t3.exchanges.length, 3, "the plain-HTTP code never left Top");
  assert.equal((await readT3Config(file))?.url, t3.origin, "the connection Top had stays");

  // A T3 Code that puts Top's credential in what it lists (a project named after it) still never shows it.
  const echoing = await fakeT3({ projects: [{ id: t3.token(), workspaceRoot: "/srv/echo" }] });
  servers.push(echoing);
  const echoFile = join(mkdtempSync(join(tmpdir(), "top-t3-echo-")), "t3code.json");
  const listed = await linked(echoFile, (link) => link.connect(echoing.origin, echoing.pairingCode(), false));
  assert.equal(listed.projects?.[0]?.path, "/srv/echo");
  assert.ok(!JSON.stringify(listed).includes(echoing.token()) && !JSON.stringify(await linked(echoFile, (link) => link.view)).includes(echoing.token()));

  // Nor one T3 Code puts in its own label: the saved connection never holds it.
  const labelled = await fakeT3();
  servers.push(labelled);
  const labelCode = labelled.pairingCode();
  labelled.setLabel(`box ${labelCode}`);
  const labelFile = join(mkdtempSync(join(tmpdir(), "top-t3-label-")), "t3code.json");
  await linked(labelFile, (link) => link.connect(labelled.origin, labelCode, false));
  assert.equal((await readT3Config(labelFile))?.label, "box [hidden]");
  const health = await t3codeAdapter({ file: labelFile }).check();
  assert.ok(health.ok && !health.version.includes(labelCode), "a task's log names T3 Code by the label Top saved");
  assert.ok(!JSON.stringify(await linked(labelFile, (link) => link.view)).includes(labelCode));

  t3.revoke();
  const revoked = await linked(file, (link) => link.view);
  assert.equal(revoked.url, t3.origin);
  assert.match(revoked.error ?? "", /no longer accepts Top's credential.*Settings → T3 Code/);

  await linked(file, (link) => link.disconnect);
  assert.equal(await readT3Config(file), undefined);
  assert.deepEqual(await linked(file, (link) => link.view), {});
});

test("task_start offers T3 Code from the next turn after Top pairs with it, and stops when it disconnects", async () => {
  const dir = mkdtempSync(join(tmpdir(), "top-t3-offer-"));
  const file = join(dir, "t3code.json");
  const h = await harness({ dir, harnesses: [fakeHarness(), t3codeAdapter({ file })] });
  await h.run(h.daemon.start);
  const offered = () => {
    const tool = h.daemon.toolsOf(h.bot).find((t) => t.name === "collar__task_start")!;
    const parameters = tool.parameters as unknown as { properties: { harness: { enum: string[] } } };
    return { harnesses: parameters.properties.harness.enum, described: tool.description.includes('"t3code" (T3 Code)') };
  };
  assert.deepEqual(offered(), { harnesses: ["fake"], described: false }, "not offered before pairing");
  await writeT3Config(file, { url: "http://127.0.0.1:1", token: "t", environmentId: "e", label: "x", serverVersion: "1", connectedAt: "now" });
  assert.deepEqual(offered(), { harnesses: ["fake", "t3code"], described: true });
  await linked(file, (link) => link.disconnect);
  assert.deepEqual(offered(), { harnesses: ["fake"], described: false }, "gone again once Top forgets it");
});
