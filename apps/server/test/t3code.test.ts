import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { WebSocketServer } from "ws";
import { harnessLines } from "../src/collar/tasks.ts";
import type { HarnessEvent, OpenSpec } from "../src/tasks/harness.ts";
import { T3CODE, t3codeAdapter } from "../src/tasks/t3code.ts";
import { until } from "./harness.ts";

const FAKE_T3 = join(import.meta.dirname, "fixtures", "fake-t3.mjs");
const TOKEN = "t3-secret-token-abcdefghijklmnop";

type Rec = Record<string, unknown>;
const closing: (() => void)[] = [];
afterEach(() => {
  for (const close of closing.splice(0)) close();
  delete process.env.FAKE_T3_DIR;
  delete process.env.FAKE_T3_THREAD;
  delete process.env.FAKE_T3_SEND_DELAY_MS;
});

/** T3 Code's server as far as Top's stop and steer reach it: its descriptor, a socket ticket for the CLI's session, and /ws. */
async function fakeServer(dir: string, protocol = 2) {
  const commands: Rec[] = [];
  const tickets: string[] = [];
  const http = createServer((req, res) => {
    if (req.url === "/.well-known/t3/environment") return res.end(JSON.stringify({ serverVersion: "9.9.9-fake", orchestrationProtocolVersion: protocol }));
    if (req.url === "/api/auth/websocket-ticket/rpc" && req.method === "POST") {
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return res.writeHead(401).end("{}");
      const ticket = `ticket-${tickets.length + 1}`;
      tickets.push(ticket);
      return res.end(JSON.stringify({ ticket }));
    }
    res.writeHead(404).end("{}");
  });
  const wss = new WebSocketServer({ noServer: true });
  http.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname !== "/ws" || !tickets.includes(url.searchParams.get("wsTicket") ?? "") || url.searchParams.get("orchestrationProtocol") !== "2")
      return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) =>
      ws.on("message", (data) => {
        const frame = JSON.parse(String(data)) as Rec;
        if (frame._tag !== "Request" || frame.tag !== "orchestration.dispatchCommand") return;
        const command = frame.payload as Rec;
        commands.push(command);
        if (command.type === "thread.stop" && existsSync(join(dir, `running-${command.threadId}`))) writeFileSync(join(dir, `stopped-${command.threadId}`), "");
        ws.send(JSON.stringify({ _tag: "Exit", requestId: frame.id, exit: { _tag: "Success", value: { sequence: 1 } } }));
      }),
    );
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  closing.push(() => {
    wss.close();
    http.close();
    http.closeAllConnections();
  });
  return { origin: `http://127.0.0.1:${(http.address() as AddressInfo).port}`, commands };
}

async function setup(options: { running?: boolean; protocol?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "top-t3-"));
  process.env.FAKE_T3_DIR = dir;
  const home = join(dir, "home");
  mkdirSync(join(home, "userdata"), { recursive: true });
  const server = await fakeServer(dir, options.protocol);
  if (options.running !== false)
    writeFileSync(join(home, "userdata", "server-runtime.json"), JSON.stringify({ origin: server.origin, serverVersion: "9.9.9-fake", pid: 1 }));
  const cwd = join(dir, "project");
  mkdirSync(cwd);
  const calls = () =>
    (existsSync(join(dir, "calls.jsonl")) ? readFileSync(join(dir, "calls.jsonl"), "utf8") : "")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { args: string[]; cwd: string; home: string; pid: number; message?: string });
  return { dir, home, cwd, server, calls, adapter: t3codeAdapter({ command: FAKE_T3, home }) };
}

const spec = (cwd: string, over: Partial<OpenSpec> = {}): OpenSpec => ({
  session: "ses_test",
  cwd,
  model: undefined,
  options: {},
  resume: undefined,
  fork: false,
  ...over,
});

const collect = () => {
  const events: HarnessEvent[] = [];
  return {
    events,
    emit: (event: HarnessEvent) => events.push(event),
    of: <T extends HarnessEvent["type"]>(type: T) => events.filter((e): e is Extract<HarnessEvent, { type: T }> => e.type === type),
  };
};

test("T3 Code is ready while its server runs here, and says so when it doesn't", async () => {
  const s = await setup();
  assert.deepEqual(await s.adapter.check(), { ok: true, version: "9.9.9-fake" });
  const off = await setup({ running: false });
  const down = (await off.adapter.check()) as { ok: false; error: string };
  assert.match(down.error, /^T3 Code isn't running on this computer \(no server uses .*home\)\. Start T3 Code and try again\.$/);
  assert.match(
    harnessLines([s.adapter]),
    /^- "t3code" \(T3 Code\): can resume, steer, queue, cancel, reconnect; can't fork, questions, images, fileChanges, usage, durable\./m,
  );
  assert.equal(s.adapter.id, T3CODE);
});

test("T3 Code: a task starts a thread in the folder's project and waits for T3 Code to say it ended; the next one goes to the same thread", async () => {
  const s = await setup();
  const c = collect();
  const session = await s.adapter.open(spec(s.cwd, { model: "claude-haiku-5-5", options: { provider: "claudeAgent" } }), c.emit);
  await session.run({ key: "k", text: "fix the login bug", images: [] });
  assert.deepEqual(await until("the end", () => c.of("turn_ended")[0]), { type: "turn_ended", status: "completed", result: "done: fix the login bug" });
  assert.deepEqual(c.of("session"), [{ type: "session", externalId: "thr-1", model: "claude-haiku-5-5" }]);
  const [started] = s.calls();
  assert.deepEqual(started!.args, ["thread", "start", s.cwd, "-", "--wait", "--provider", "claudeAgent", "--model", "claude-haiku-5-5"]);
  assert.equal(started!.message, "fix the login bug", "the message goes on stdin");
  assert.equal(started!.cwd, s.cwd);
  assert.equal(started!.home, s.home, "the CLI uses the same T3 Code that Top looked at");

  // A queued message in the same task, then a later task that carries on the session: both to the thread.
  await session.run({ key: "k:m1", text: "and the tests", images: [] });
  await until("the second turn", () => c.of("turn_ended")[1]);
  const later = collect();
  await (await s.adapter.open(spec(s.cwd, { resume: "thr-1" }), later.emit)).run({ key: "k2", text: "more", images: [] });
  assert.deepEqual(await until("the follow-up", () => later.of("turn_ended")[0]), { type: "turn_ended", status: "completed", result: "done: more" });
  assert.deepEqual(later.of("session"), [{ type: "session", externalId: "thr-1" }], "a continued session is known before anything is sent");
  assert.deepEqual(
    s.calls().map((call) => call.args),
    [started!.args, ["thread", "send", "thr-1", "-", "--wait"], ["thread", "send", "thr-1", "-", "--wait"]],
  );
});

test("T3 Code: a run that fails, waits for an answer, or never finds its project ends the task saying so", async () => {
  const s = await setup();
  const ended = async (text: string) => {
    const c = collect();
    await (await s.adapter.open(spec(s.cwd), c.emit)).run({ key: "k", text, images: [] });
    return until(text, () => c.of("turn_ended")[0]);
  };
  assert.deepEqual(await ended("fail"), { type: "turn_ended", status: "failed", error: "T3 Code's run ended as failed: the provider broke" });
  assert.deepEqual(await ended("a question"), {
    type: "turn_ended",
    status: "handed_off",
    result: "T3 Code is waiting for an answer in https://app.t3.codes/threads/env-fake/thr-1. The user answers it there; Top doesn't see how the run ends.",
  });
  const lost = await ended("noproject");
  assert.equal(lost.status, "failed");
  assert.match(lost.error!, /^T3 Code didn't start the thread: No T3 Code project matches '.*project'\./);
  await assert.rejects(
    s.adapter.open(spec(s.cwd, { model: "haiku" }), () => {}),
    /takes `model` together with `provider`/,
  );
});

test("T3 Code: cancel is T3 Code's own Stop on the task's thread, through a session made for it and revoked; the credential goes nowhere", async () => {
  const s = await setup();
  const c = collect();
  const session = await s.adapter.open(spec(s.cwd), c.emit);
  await session.run({ key: "k", text: "run forever", images: [] });
  await until("the thread", () => c.of("session")[0]);
  await session.interrupt();
  assert.deepEqual(await until("the stop", () => c.of("turn_ended")[0]), { type: "turn_ended", status: "interrupted", error: "Stopped." });
  assert.equal(s.server.commands.length, 1);
  assert.deepEqual(
    { ...s.server.commands[0], commandId: undefined },
    { type: "thread.stop", commandId: undefined, threadId: "thr-1", reason: "Cancelled in Top." },
  );
  const auth = s.calls().filter((call) => call.args[0] === "auth");
  assert.deepEqual(
    auth.map((call) => call.args),
    [
      ["auth", "session", "issue", "--scope", "orchestration:operate", "--ttl", "5m", "--label", "Top", "--json"],
      ["auth", "session", "revoke", "ses-fake"],
    ],
  );
  assert.doesNotMatch(JSON.stringify(c.events), new RegExp(TOKEN));
});

test("T3 Code: a cancel before T3 Code names the thread goes out once it does", async () => {
  const s = await setup();
  const c = collect();
  const session = await s.adapter.open(spec(s.cwd), c.emit);
  await session.run({ key: "k", text: "run forever", images: [] });
  await session.interrupt();
  assert.equal((await until("the stop", () => c.of("turn_ended")[0])).status, "interrupted");
  assert.equal(s.server.commands[0]?.type, "thread.stop");
});

test("T3 Code: a cancel while a follow-up is still on its way waits for T3 Code to have it, so its run doesn't start after the Stop", async () => {
  const s = await setup();
  process.env.FAKE_T3_SEND_DELAY_MS = "600";
  const c = collect();
  const session = await s.adapter.open(spec(s.cwd, { resume: "thr-1" }), c.emit);
  await session.run({ key: "k", text: "run forever", images: [] });
  await until("the send", () => s.calls().some((call) => call.args[1] === "send"));
  await session.interrupt();
  assert.deepEqual(await until("the stop", () => c.of("turn_ended")[0], 10_000), { type: "turn_ended", status: "interrupted", error: "Stopped." });
  assert.deepEqual(
    s.server.commands.map((command) => command.type),
    ["thread.stop"],
  );
});

test("T3 Code: steering goes into the run that's going, and a stop T3 Code can't take is logged", async () => {
  const s = await setup();
  const c = collect();
  const session = await s.adapter.open(spec(s.cwd), c.emit);
  await assert.rejects(session.steer("too soon"), /no run of this task going to steer yet/);
  await session.run({ key: "k", text: "run forever", images: [] });
  await until("the run", () => c.of("session")[0]);
  await until("the run to be going", () => s.calls().some((call) => call.args[1] === "start"));
  await session.steer("go left");
  const [steer] = s.server.commands;
  assert.deepEqual(
    { ...steer, commandId: undefined, messageId: undefined },
    {
      type: "message.dispatch",
      createdBy: "user",
      creationSource: "web",
      commandId: undefined,
      threadId: "thr-1",
      messageId: undefined,
      text: "go left",
      attachments: [],
      dispatchMode: { type: "steer_active", targetRunId: "run:thr-1:1" },
    },
  );
  assert.equal(steer!.commandId, steer!.messageId);

  // T3 Code now speaks another protocol: the stop isn't sent, and the task hears why.
  writeFileSync(join(s.home, "userdata", "server-runtime.json"), JSON.stringify({ origin: (await fakeServer(s.dir, 3)).origin, serverVersion: "9.9.9-fake" }));
  await session.interrupt();
  assert.match(
    (await until("the logged refusal", () => c.of("log")[0])).text,
    /^T3 Code didn't take the stop: T3 Code 9\.9\.9-fake speaks orchestration protocol 3, and Top's stop and steer speak 2\. Update Top\.$/,
  );
  await session.close();
});

test("T3 Code: closing stops only Top's wait, and says nothing more", async () => {
  const s = await setup();
  const c = collect();
  const session = await s.adapter.open(spec(s.cwd), c.emit);
  await session.run({ key: "k", text: "run forever", images: [] });
  await until("the thread", () => c.of("session")[0]);
  await session.close();
  const pid = s.calls().find((call) => call.args[1] === "start")!.pid;
  await until("the CLI's wait to end", () => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(c.of("turn_ended"), []);
  assert.deepEqual(s.server.commands, [], "the run in T3 Code isn't stopped");
  await assert.rejects(session.run({ key: "k2", text: "more", images: [] }), /closed/);
});
