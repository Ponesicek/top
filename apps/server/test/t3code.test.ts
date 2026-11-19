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
import { credentialOf } from "../src/t3cli.ts";
import type { StartRequest, Tasks } from "../src/tasks/coordinator.ts";
import { plainHttpExposed, readT3Config, t3Origin, writeT3Config } from "../src/tasks/t3api.ts";
import { T3CODE, t3Answers, t3codeAdapter } from "../src/tasks/t3code.ts";
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
  const h = await harness({ dir, harnesses: [t3codeAdapter({ file, reconnectForMs: 3_000 })], context: true, taskCancelGraceMs: 2_000, gatherMs: 20 });
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
  const first = await start(s, { prompt: "fix the login bug", model: "haiku" });
  assert.equal(first.session.cwd, "/srv/app");
  const done = await ended(s, first.task.id);
  assert.equal(done.state, "completed", done.error ?? "");
  assert.equal(done.result, "done: fix the login bug");
  const thread = `top-${first.session.id}`;
  const launch = s.t3.requests.find((r) => r.tag === "orchestration.launchThread")!.payload;
  assert.deepEqual(launch.modelSelection, { instanceId: "claudeAgent", model: "claude-haiku-5-5" }, "a model alias picks its provider");
  assert.equal(launch.runtimeMode, "full-access");
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
  assert.ok((await log(s, running.task.id)).some((t) => t === "reconnected to T3 Code"));
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
  assert.match(done.error ?? "", /Lost T3 Code at http:\/\/127\.0\.0\.1:\d+ for 3s .*may still be running there/);
  assert.equal(s.t3.requests.filter((r) => r.tag === "orchestration.launchThread").length, 0);
});

test("questions reach the bot and the user, and the answer goes back as the option's value", async () => {
  assert.deepEqual(
    t3Answers(
      {
        questions: [
          { id: "a", options: [{ label: "Red", value: "red" }] },
          { id: "b", multiSelect: true, options: [{ label: "X" }] },
        ],
      },
      { a: ["Red"], b: ["X", "own words"] },
    ),
    { a: "red", b: ["X", "own words"] },
  );
  const s = await setup();
  const asking = await start(s, { prompt: "a question" });
  await inState(s, asking.task.id, "waiting_for_input");
  const snapshot = await s.h.run(s.tasks.snapshot(s.h.bot, asking.task.id));
  const input = snapshot.inputs[0]!;
  assert.deepEqual(
    input.questions[0]!.options.map((o) => o.label),
    ["Red", "Blue"],
  );
  await s.h.run(s.tasks.respond("user", undefined, asking.task.id, input.id, { answers: { color: ["Red"] } }));
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
  await second.h.run(second.tasks.respond("user", undefined, asking.task.id, input.id, { answers: { color: ["Blue"] } }));
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
  await store.run(store.store.tasks.answerInput(input.id, { answers: { color: ["Red"] } }, "user"));
  await store.close();

  const second = await setup({ dir: first.dir, t3: first.t3 });
  const done = await ended(second, asking.task.id);
  assert.equal(done.result, 'answer: {"color":"red"}');
});

test("addresses are explicit, and plain HTTP is accepted only where it stays private", () => {
  assert.equal(t3Origin(" https://box.tail1.ts.net/some/path "), "https://box.tail1.ts.net");
  assert.throws(() => t3Origin("box.tail1.ts.net"), /isn't an address/);
  assert.throws(() => t3Origin("ftp://box"), /https:\/\/ or http:\/\//);
  assert.throws(() => t3Origin("https://me:secret@box"), /Leave the sign-in out/);
  assert.equal(plainHttpExposed("http://127.0.0.1:3773"), false);
  assert.equal(plainHttpExposed("http://[::1]:3773"), false);
  assert.equal(plainHttpExposed("http://127.evil.example:3773"), true, "a name that starts like loopback isn't loopback");
  assert.equal(plainHttpExposed("http://100.78.69.34:3773"), true, "a tailnet address takes --plain-http too");
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
  writeFileSync(file, "{}");
  await assert.rejects(readT3Config(file), /missing its address or credential/);
});
