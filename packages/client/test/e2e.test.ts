import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll as after, test } from "vitest";
import { type BotSummary, type ConversationSnapshot, type ConversationSync, type Entry, TopClient, type WaitingAsk } from "../src/index.ts";

const serverMain = resolve(import.meta.dirname, "../../../apps/server/src/main.ts");
const cleanup: (() => Promise<void> | void)[] = [];
after(async () => {
  for (const fn of cleanup.reverse()) await fn();
});

let nextPort = 7400 + Math.floor(Math.random() * 50) * 10;

class Daemon {
  readonly dataDir = mkdtempSync(join(tmpdir(), "top-e2e-"));
  readonly port: number;
  process: ChildProcess | undefined;
  output = "";

  readonly extra: string[];

  constructor(extra: string[] = [], port = nextPort++) {
    this.extra = extra;
    this.port = port;
    cleanup.push(async () => {
      await this.kill();
      rmSync(this.dataDir, { recursive: true, force: true });
    });
  }

  get url() {
    return `ws://127.0.0.1:${this.port}`;
  }

  start(): Promise<void> {
    return new Promise((resolveStart, reject) => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", serverMain, "--port", String(this.port), "--home", this.dataDir, "--tps", "120", ...this.extra],
        {
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, TOP_RETRY_DELAYS_MS: "200,200,200" },
        },
      );
      this.process = child;
      let listening = false;
      child.stdout!.on("data", (chunk: Buffer) => {
        this.output += chunk;
        if (String(chunk).includes("listening")) {
          listening = true;
          resolveStart();
        }
      });
      child.stderr!.on("data", (chunk: Buffer) => (this.output += chunk));
      child.on("exit", (code, signal) => {
        if (listening) return;
        reject(new Error(`daemon ${signal ? `died (${signal})` : `exited ${code}`} during startup\n${this.output.slice(-2000)}`));
      });
    });
  }

  exited(): Promise<void> {
    return new Promise((r) => {
      if (!this.process || this.process.exitCode !== null || this.process.signalCode !== null) return r();
      this.process.once("exit", () => r());
    });
  }

  async kill() {
    if (this.process && this.process.exitCode === null && this.process.signalCode === null) this.process.kill("SIGKILL");
    await this.exited();
  }

  effects(tool: string, phase: string): number {
    try {
      return readFileSync(join(this.dataDir, "server", "effects.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { tool: string; phase: string })
        .filter((e) => e.tool === tool && e.phase === phase).length;
    } catch {
      return 0;
    }
  }
}

function until<T>(
  subscribe: (listener: () => void) => () => void,
  read: () => T,
  predicate: (value: T) => boolean,
  what: string,
  timeoutMs = 20_000,
): Promise<T> {
  return new Promise<T>((r, reject) => {
    const check = () => {
      const value = read();
      if (!predicate(value)) return;
      off();
      clearTimeout(timer);
      r(value);
    };
    const off = subscribe(check);
    const timer = setTimeout(() => {
      off();
      reject(new Error(`timed out waiting for ${what}`));
    }, timeoutMs);
    check();
  });
}

const untilBot = (sync: ConversationSync, predicate: (s: ConversationSnapshot) => boolean, what: string, timeoutMs?: number) =>
  until(sync.subscribe, sync.getSnapshot, predicate, what, timeoutMs);

const untilSummary = (top: TopClient, id: number, predicate: (b: BotSummary) => boolean, what: string, timeoutMs?: number) =>
  until(
    top.subscribe,
    () => top.getSnapshot().bots.find((b) => b.id === id),
    (b) => !!b && predicate(b),
    what,
    timeoutMs,
  );

const entries = (s: ConversationSnapshot) => s.items.flatMap((i) => (i.kind === "entry" ? [i.entry] : []));
const ofKind = <K extends Entry["kind"]>(s: ConversationSnapshot, kind: K) => entries(s).filter((e): e is Extract<Entry, { kind: K }> => e.kind === kind);

async function connect(daemon: Daemon, botIndex: number, opened?: TopClient[]) {
  const top = new TopClient({ url: daemon.url });
  cleanup.push(() => top.close());
  opened?.push(top);
  await until(top.subscribe, top.getSnapshot, (s) => s.ready, "the roster");
  const id = top.getSnapshot().bots[botIndex]!.id;
  const bot = top.conversation(id);
  bot.retain();
  await untilBot(bot, (s) => s.status === "live", "the first sync");
  return { top, bot, id };
}

const settled = (s: ConversationSnapshot) => s.status === "live" && s.pending.length === 0 && s.inbox.length === 0;

test("send, crash mid-answer, send while down, restart: nothing lost or doubled", async () => {
  const daemon = new Daemon(["--tps", "40"]);
  await daemon.start();
  const { top, bot, id } = await connect(daemon, 0);

  const sent = bot.send("hello from the e2e test");
  assert.equal(bot.getSnapshot().pending[0]!.requestId, sent.requestId);
  await untilBot(bot, (s) => s.pending.length === 0 && ofKind(s, "user").length === 1, "the message to land");
  await untilSummary(top, id, (b) => b.status === "thinking", "the bot to start answering");
  await new Promise((r) => setTimeout(r, 300));

  await daemon.kill();
  const stale = await untilBot(bot, (s) => s.status === "stale", "the stale state");
  assert.equal(ofKind(stale, "user").length, 1, "what we had stays on screen");

  bot.send("sent while offline");
  assert.equal(bot.getSnapshot().pending.length, 1);

  await daemon.start();
  const done = await until(
    (listener) => {
      const offs = [bot.subscribe(listener), top.subscribe(listener)];
      return () => {
        for (const off of offs) off();
      };
    },
    () => ({ s: bot.getSnapshot(), b: top.getSnapshot().bots.find((x) => x.id === id) }),
    ({ s, b }) => settled(s) && b?.status === "idle" && ofKind(s, "assistant").length >= 2 && ofKind(s, "user").length === 2,
    "both messages answered",
    40_000,
  ).catch((error: Error) => {
    const s = bot.getSnapshot();
    const b = top.getSnapshot().bots.find((x) => x.id === id);
    throw new Error(
      `${error.message}: ${JSON.stringify({ status: s.status, pending: s.pending, inbox: s.inbox, bot: b, entries: entries(s).map((e) => [e.seq, e.kind, e.kind === "files" ? e.files.length : e.kind === "answer" ? e.answer : e.kind === "user" ? e.text : e.text.slice(0, 30)]) })}\n${daemon.output.slice(-1500)}`,
    );
  });
  assert.deepEqual(
    ofKind(done.s, "user").map((e) => e.text),
    ["hello from the e2e test", "sent while offline"],
  );
  const seqs = entries(done.s).map((e) => e.seq);
  assert.deepEqual(
    seqs,
    [...seqs].sort((a, b) => a - b),
    "in order",
  );
  assert.equal(new Set(seqs).size, seqs.length, "no duplicates");
  assert.equal(ofKind(done.s, "assistant").length, 2);
});

async function killDuringTool(prompt: string, tool: string) {
  const daemon = new Daemon();
  await daemon.start();
  const { top, bot, id } = await connect(daemon, 1);
  bot.send(prompt);
  await untilSummary(top, id, (b) => b.status === "tool" && b.tool === tool, `${tool} to start`);
  await new Promise((r) => setTimeout(r, 400));
  await daemon.kill();
  await daemon.start();
  const s = await untilBot(
    bot,
    (s) => settled(s) && ofKind(s, "tool").length === 1 && ofKind(s, "assistant").length === 2,
    "the task to finish after the restart",
    30_000,
  );
  await untilSummary(top, id, (b) => b.status === "idle", "idle");
  return { daemon, s, result: ofKind(s, "tool")[0]! };
}

test("a tool that may have taken effect is not run again; the model is told", async () => {
  const { daemon, result, s } = await killDuringTool("deploy web 4s", "deploy");
  assert.equal(result.outcome, "interrupted");
  assert.equal(result.isError, true);
  assert.match(result.text, /may or may not have taken effect/);
  assert.equal(daemon.effects("deploy", "effect"), 1, "deployed exactly once");
  assert.match(ofKind(s, "assistant").at(-1)!.text, /Interrupted/, "the model saw what happened");
});

test("a tool that can check its outcome reports what really happened", async () => {
  const { daemon, result } = await killDuringTool("email the team 4s", "send_email");
  assert.equal(result.outcome, "recovered");
  assert.equal(result.isError, undefined);
  assert.match(result.text, /confirmed after a restart/);
  assert.equal(daemon.effects("send_email", "effect"), 1, "sent exactly once");
});

test("a read-only tool is simply run again", async () => {
  const { daemon, result } = await killDuringTool("check status 4s", "check_status");
  assert.equal(result.outcome, "replayed");
  assert.match(result.text, /healthy/);
  assert.equal(daemon.effects("check_status", "start"), 2, "ran twice: once cut off, once after the restart");
});

test("a task that keeps crashing the daemon is ended, not restarted forever", async () => {
  const daemon = new Daemon();
  await daemon.start();
  const { bot } = await connect(daemon, 2);
  bot.send("crash");
  let restarts = 0;
  for (; restarts < 8; restarts++) {
    await daemon.exited();
    if (daemon.output.includes("task ended")) break;
    await daemon.start().catch(() => {});
    await Promise.race([daemon.exited(), new Promise((r) => setTimeout(r, 3_000))]);
    if (daemon.process!.exitCode === null && daemon.process!.signalCode === null) break;
  }
  const s = await untilBot(bot, (s) => s.status === "live" && ofKind(s, "notice").length === 1, "the stop notice", 20_000);
  assert.match(ofKind(s, "notice")[0]!.text, /restarted 4 times/);
  assert.equal(ofKind(s, "tool")[0]!.outcome, "stopped");
  assert.equal(daemon.effects("crash_daemon", "start"), 4, "the first run and three replays");
  assert.ok(restarts <= 4, `stopped after ${restarts} restarts`);
});

test("Stop during a tool ends the task; the next queued message still runs", async () => {
  const daemon = new Daemon();
  await daemon.start();
  const { top, bot, id } = await connect(daemon, 4);
  bot.send("deploy web 6s");
  await untilSummary(top, id, (b) => b.status === "tool", "the tool to start");
  bot.send("after the stop");
  await untilBot(bot, (s) => s.inbox.length === 1, "the second message to queue");
  await bot.abort();
  const s = await untilBot(
    bot,
    (s) => settled(s) && ofKind(s, "user").length === 2 && ofKind(s, "assistant").length === 2,
    "the queued message to run",
    30_000,
  );
  await untilSummary(top, id, (b) => b.status === "idle", "idle");
  const result = ofKind(s, "tool")[0]!;
  assert.equal(result.isError, true);
  assert.match(result.text, /Stopped/);
  assert.deepEqual(
    entries(s).map((e) => e.kind),
    ["user", "assistant", "tool", "notice", "user", "assistant"],
  );
  assert.equal(ofKind(s, "notice")[0]!.text, "Stopped");
  assert.match(ofKind(s, "assistant").at(-1)!.text, /after the stop/);
  assert.equal(daemon.effects("deploy", "effect"), 1);
});

test("a failed model request is retried; only a final failure shows", async () => {
  const daemon = new Daemon();
  await daemon.start();
  const { top, bot, id } = await connect(daemon, 1);
  bot.send("fail once, then answer");
  let s = await untilBot(bot, (s) => settled(s) && ofKind(s, "assistant").length === 1, "the answer after a retry");
  assert.equal(ofKind(s, "assistant")[0]!.error, undefined, "the failed attempt left no trace");
  bot.send("fail always");
  await untilSummary(top, id, (b) => b.status === "failed", "the failure after three retries", 15_000);
  s = await untilBot(bot, (s) => ofKind(s, "assistant").length === 2, "the failure entry");
  assert.match(ofKind(s, "assistant")[1]!.error!, /overloaded/);
  assert.equal(top.getSnapshot().bots.find((b) => b.id === id)!.error, "Provider overloaded (test)");
});

test("a resent message is applied once", async () => {
  const daemon = new Daemon();
  await daemon.start();
  const { bot, id } = await connect(daemon, 3);
  const socket = new WebSocket(daemon.url);
  await new Promise((r) => (socket.onopen = r));
  const results: unknown[] = [];
  socket.onmessage = (event) => {
    const frame = JSON.parse(String(event.data)) as { t: string; value?: unknown };
    if (frame.t === "result") results.push(frame.value);
  };
  const submit = (req: number) =>
    socket.send(JSON.stringify({ t: "submit", req, bot: id, requestId: "same-id", text: "only once", whenBusy: "followUp", clientId: "raw" }));
  submit(1);
  submit(2);
  for (let waited = 0; results.length < 2 && waited < 5_000; waited += 20) await new Promise((r) => setTimeout(r, 20));
  socket.close();
  assert.deepEqual(results, [{ duplicate: false }, { duplicate: true }]);
  const s = await untilBot(bot, (s) => settled(s) && ofKind(s, "assistant").length === 1, "the answer");
  assert.equal(ofKind(s, "user").filter((e) => e.text === "only once").length, 1);
});

test("reconnecting sends only what's new; a long absence leaves a gap that loads on demand", async () => {
  const daemon = new Daemon(["--seed", "400"]);
  await daemon.start();
  const first = await connect(daemon, 0);
  const s = first.bot.getSnapshot();
  assert.equal(s.items[0]!.kind, "earlier", "older history is not sent until scrolled to");
  assert.equal(entries(s).length, 50);
  const cache = first.bot.exportCache()!;
  first.top.close();

  const warm = new TopClient({ url: daemon.url });
  cleanup.push(() => warm.close());
  const warmBot = warm.conversation(first.id);
  warmBot.hydrate(cache);
  assert.equal(warmBot.getSnapshot().status, "stale");
  let synced = 0;
  const realSync = warmBot.receiveSync.bind(warmBot);
  warmBot.receiveSync = (frame) => {
    synced += frame.entries.length;
    realSync(frame);
  };
  warmBot.retain();
  await untilBot(warmBot, (x) => x.status === "live", "the warm sync");
  assert.equal(synced, 0, "nothing re-sent");
  assert.equal(entries(warmBot.getSnapshot()).length, 50);

  const stale = new TopClient({ url: daemon.url });
  cleanup.push(() => stale.close());
  const staleBot = stale.conversation(first.id);
  const old = entries(s)[0]!;
  staleBot.hydrate({ version: 2, entries: [{ ...old, seq: 10 }], gaps: [], earlier: true, inbox: [] });
  staleBot.retain();
  const gapped = await untilBot(staleBot, (x) => x.status === "live", "the stale sync");
  const gap = gapped.items.find((i) => i.kind === "gap");
  assert.ok(gap && gap.kind === "gap", "a gap marks what was skipped");
  assert.equal(gap.gap.after, 10);
  assert.equal(entries(gapped).length, 51);
  await staleBot.fillGap(gap.gap);
  const filled = staleBot.getSnapshot();
  assert.equal(entries(filled).length, 101);
  const rest = filled.items.find((i) => i.kind === "gap");
  assert.ok(rest && rest.kind === "gap" && rest.gap.after === 10 && rest.gap.before < gap.gap.before, "the gap shrinks as it loads");
});

test("a different daemon on the same address: the old one's transcript is dropped, not mixed in", async () => {
  const a = new Daemon(["--seed", "300"]);
  await a.start();
  const { top, bot } = await connect(a, 0);
  assert.equal(entries(bot.getSnapshot()).length, 50);
  const aId = top.getSnapshot().serverId!;
  assert.ok(aId);
  const cache = bot.exportCache()!;
  await a.kill();

  const b = new Daemon([], a.port);
  await b.start();
  await until(top.subscribe, top.getSnapshot, (x) => x.serverId !== aId && x.connection === "open", "the new daemon");
  await untilBot(bot, (x) => x.status === "live", "the fresh sync");
  assert.equal(entries(bot.getSnapshot()).length, 0, "nothing from the old daemon");

  bot.send("after the switch");
  const s = await untilBot(bot, (x) => ofKind(x, "assistant").length === 1, "the answer");
  assert.equal(entries(s)[0]!.kind, "user");
  assert.equal((entries(s)[0] as Extract<Entry, { kind: "user" }>).text, "after the switch", "the new message is first, not above old ones");

  const bId = top.getSnapshot().serverId;
  const held = entries(bot.getSnapshot()).length;
  await b.kill();
  await b.start();
  await until(top.subscribe, top.getSnapshot, (x) => x.connection === "open", "the restarted daemon");
  await untilBot(bot, (x) => x.status === "live", "the resumed sync");
  assert.equal(top.getSnapshot().serverId, bId);
  assert.equal(entries(bot.getSnapshot()).length, held);

  const cold = new TopClient({ url: b.url, serverId: aId });
  cleanup.push(() => cold.close());
  const coldBot = cold.conversation(bot.id);
  coldBot.hydrate(cache);
  assert.equal(entries(coldBot.getSnapshot()).length, 50);
  coldBot.retain();
  const fresh = await untilBot(coldBot, (x) => x.status === "live", "the cold sync");
  assert.deepEqual(
    entries(fresh).map((e) => e.kind),
    entries(bot.getSnapshot()).map((e) => e.kind),
  );
  assert.ok(!entries(fresh).some((e) => e.kind === "user" && e.text.includes("(#")), "no seeded history");
});

test("bots made and deleted from the app: every client sees it, and a restart keeps it so", async () => {
  const daemon = new Daemon();
  await daemon.start();
  const a = await connect(daemon, 0);
  const b = await connect(daemon, 0);
  const seeded = a.top.getSnapshot().bots.length;

  const id = await a.top.createBot("  Scout  ", "Watches the build and reports breakages.");
  const made = a.top.getSnapshot().bots.find((bot) => bot.id === id);
  assert.equal(made?.name, "Scout", "in the roster by the time createBot resolves, name trimmed");
  assert.equal(made?.description, "Watches the build and reports breakages.");
  await untilSummary(b.top, id, () => true, "the new bot on the other client");
  await assert.rejects(a.top.createBot("scout", ""), /already a bot named scout/);
  await assert.rejects(a.top.createBot("   ", ""), /Give the bot a name/);
  assert.equal(made?.avatar, undefined, "the name's own drawing unless another was picked");

  const iconId = await a.top.createBot("Lark", "", 42);
  assert.equal(a.top.getSnapshot().bots.find((bot) => bot.id === iconId)?.avatar, 42);
  await untilSummary(b.top, iconId, (bot) => bot.avatar === 42, "the picked icon on the other client");
  await assert.rejects(a.top.createBot("Wren", "", -1), /icon doesn't exist/);
  await assert.rejects(a.top.createBot("Wren", "", 1.5), /Expected an integer/);
  await assert.rejects(a.top.createBot("Wren", "", 10_000), /icon doesn't exist/);

  const files = await a.top.contextFiles(id);
  assert.deepEqual(
    files.map((f) => f.name),
    ["SOUL.md", "AGENTS.md", "USER.md", "MEMORY.md"],
  );
  assert.equal(files[0]!.content, "# Scout\n\nWatches the build and reports breakages.\n");
  assert.equal(files[0]!.path, join(daemon.dataDir, "bots", "Scout", "SOUL.md"));
  assert.deepEqual(files[3], { name: "MEMORY.md", path: join(daemon.dataDir, "bots", "Scout", "MEMORY.md"), content: "", version: "" });
  const version = await a.top.saveContextFile(id, "SOUL.md", "# Scout\n\nWatches the build, nightly.\n", files[0]!.version);
  await untilSummary(b.top, id, (bot) => bot.description === "Watches the build, nightly.", "the edited SOUL.md on the other client");
  await assert.rejects(a.top.saveContextFile(id, "SOUL.md", "# Old\n", files[0]!.version), /changed since you opened it/);
  assert.equal((await a.top.contextFiles(id))[0]!.version, version);

  const scout = a.top.conversation(id);
  scout.retain();
  await untilBot(scout, (s) => s.status === "live", "the new bot's first sync");
  scout.send("hello");
  await untilBot(scout, (s) => settled(s) && ofKind(s, "assistant").length === 1, "the new bot's answer");

  a.bot.send("deploy web 5s");
  await untilSummary(a.top, a.id, (bot) => bot.status === "tool", "the first bot running a tool");
  await a.top.deleteBot(a.id);
  assert.equal(
    a.top.getSnapshot().bots.some((bot) => bot.id === a.id),
    false,
  );
  await until(b.top.subscribe, b.top.getSnapshot, (s) => !s.bots.some((bot) => bot.id === a.id), "the deleted bot gone on the other client");
  await assert.rejects(a.top.deleteBot(a.id), /Unknown bot/);

  await daemon.kill();
  await daemon.start();
  const c = new TopClient({ url: daemon.url });
  cleanup.push(() => c.close());
  const roster = (await until(c.subscribe, c.getSnapshot, (s) => s.ready, "the roster after restart")).bots;
  assert.equal(roster.length, seeded + 1);
  assert.ok(roster.some((bot) => bot.id === id && bot.name === "Scout" && bot.avatar === undefined));
  assert.ok(
    roster.some((bot) => bot.id === iconId && bot.avatar === 42),
    "the picked icon kept across a restart",
  );
  assert.ok(!roster.some((bot) => bot.id === a.id));

  for (const bot of roster) await c.deleteBot(bot.id);
  await daemon.kill();
  await daemon.start();
  const d = new TopClient({ url: daemon.url });
  cleanup.push(() => d.close());
  assert.equal((await until(d.subscribe, d.getSnapshot, (s) => s.ready, "the empty roster")).bots.length, 0);
});

test("bots reordered on one client are in that order on every client, and stay so after a restart", async () => {
  const daemon = new Daemon();
  // This test's daemon and clients stop when it ends, not at the end of the file.
  const opened: TopClient[] = [];
  try {
    await daemon.start();
    const a = await connect(daemon, 0, opened);
    const b = await connect(daemon, 0, opened);
    const ids = a.top.getSnapshot().bots.map((bot) => bot.id);
    assert.ok(ids.length >= 3, "the fake bots");
    const order = [ids[2]!, ids[0]!, ...ids.slice(3), ids[1]!];
    const done = a.top.setBotOrder(order);
    assert.deepEqual(
      a.top.getSnapshot().bots.map((bot) => bot.id),
      order,
      "in order here at once",
    );
    await done;
    await until(b.top.subscribe, b.top.getSnapshot, (s) => s.bots.map((bot) => bot.id).join() === order.join(), "the order on the other client");

    await daemon.kill();
    await daemon.start();
    const c = new TopClient({ url: daemon.url });
    opened.push(c);
    const roster = (await until(c.subscribe, c.getSnapshot, (s) => s.ready, "the roster after restart")).bots;
    assert.deepEqual(
      roster.map((bot) => bot.id),
      order,
    );
  } finally {
    for (const client of opened) client.close();
    await daemon.kill();
  }
});

test("MCP servers set up from the app: every client sees them, bots get them only when assigned", async () => {
  const daemon = new Daemon();
  await daemon.start();
  const a = await connect(daemon, 0);
  const b = await connect(daemon, 0);
  const echo = resolve(import.meta.dirname, "../../../apps/server/test/fixtures/echo-mcp.mjs");
  const config = { transport: "stdio" as const, command: process.execPath, args: [echo], env: [{ name: "TOKEN", value: "s3cret" }] };

  const id = await a.top.saveMcpServer(undefined, "Echo", config);
  await assert.rejects(a.top.saveMcpServer(undefined, "echo", config), /already a server named Echo/);
  const ready = (top: TopClient) =>
    until(
      top.subscribe,
      () => top.getSnapshot().mcpServers.find((s) => s.id === id),
      (s) => s?.state === "ready",
      "the server connected",
    );
  const seen = await ready(b.top);
  assert.deepEqual(seen!.tools, ["echo", "env", "fail"]);
  assert.deepEqual(seen!.bots, [], "no bot has it until it's given one");
  assert.deepEqual(seen!.config, { ...config, env: [{ name: "TOKEN" }] }, "the secret stays on the daemon");

  a.bot.send('call echo__echo {"text": "before"}');
  let s = await untilBot(a.bot, (x) => settled(x) && ofKind(x, "assistant").length >= 2, "the unassigned call");
  assert.match(ofKind(s, "tool").at(-1)!.text, /not found/i);

  await a.top.assignMcp(id, a.id, true);
  await until(
    b.top.subscribe,
    () => b.top.getSnapshot().mcpServers.find((s) => s.id === id)?.bots,
    (bots) => bots?.[0] === a.id,
    "the assignment on the other client",
  );
  await assert.rejects(a.top.assignMcp(id, 9_999, true), /Unknown bot/);

  a.bot.send('call echo__echo {"text": "after"}');
  s = await untilBot(a.bot, (x) => settled(x) && ofKind(x, "assistant").length >= 4, "the assigned call");
  const result = ofKind(s, "tool").at(-1)!;
  assert.equal(result.name, "echo__echo");
  assert.equal(result.text, "echo: after");
  assert.equal(result.isError, undefined);

  await daemon.kill();
  await daemon.start();
  const c = new TopClient({ url: daemon.url });
  cleanup.push(() => c.close());
  const after = await ready(c);
  assert.deepEqual(after!.bots, [a.id]);

  await c.deleteMcpServer(id);
  await until(c.subscribe, c.getSnapshot, (s) => s.mcpServers.length === 0, "the server gone");
});

test("skills from the app: found in the home and the bot's folder, switched on per bot, used with /<name>, kept across a restart", async () => {
  const daemon = new Daemon();
  const skill = (folder: string, name: string, description: string) => {
    mkdirSync(join(folder, name), { recursive: true });
    writeFileSync(join(folder, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\nRead references/form.md first.\n`);
  };
  skill(join(daemon.dataDir, "skills"), "pdf", "Fill in PDF forms.");
  await daemon.start();
  const a = await connect(daemon, 0);
  const b = await connect(daemon, 0);
  const name = a.top.getSnapshot().bots[0]!.name;
  const skillsOf = (top: TopClient) => top.getSnapshot().skills;
  const mine = (top: TopClient) => skillsOf(top)?.bots.find((x) => x.bot === a.id);

  const first = await until(
    b.top.subscribe,
    () => skillsOf(b.top),
    (v) => !!v,
    "the skills",
  );
  assert.deepEqual(
    first!.shared.map((x) => x.name),
    ["pdf"],
  );
  assert.ok(
    first!.bots.every((x) => x.enabled.length === 0),
    "no bot has a skill until it's switched on",
  );

  skill(join(daemon.dataDir, "bots", name, ".agents", "skills"), "notes", "Keep notes.");
  await a.top.rescanSkills();
  await until(
    b.top.subscribe,
    () => mine(b.top)?.local.map((x) => x.name),
    (n) => n?.[0] === "notes",
    "the bot's own skill",
  );

  await a.top.enableSkills(a.id, ["pdf"], true);
  await until(
    b.top.subscribe,
    () => mine(b.top)?.enabled,
    (e) => e?.[0] === "pdf",
    "the skill switched on, on the other client",
  );
  await assert.rejects(a.top.enableSkills(a.id, ["nope"], true), /no skill named nope/);

  const pack = mkdtempSync(join(tmpdir(), "top-e2e-pack-"));
  cleanup.push(() => rmSync(pack, { recursive: true, force: true }));
  skill(pack, "review", "Review a change.");
  skill(pack, "pdf", "Another PDF skill.");
  const preview = await a.top.previewSkillFolder(pack);
  assert.deepEqual(
    preview.skills.map((x) => [x.skill.name, x.state]),
    [
      ["pdf", "taken"],
      ["review", "new"],
    ],
  );
  await assert.rejects(a.top.addSkillFolder(pack, [a.id, 9_999]), /9999/);
  assert.equal(
    skillsOf(a.top)?.shared.find((x) => x.name === "review"),
    undefined,
    "an unknown bot stops it before anything is linked",
  );
  const added = await a.top.addSkillFolder(pack, [a.id]);
  assert.deepEqual(added.added, ["review"]);
  assert.deepEqual(added.enabled, [{ bot: a.id, names: ["review"] }]);
  await until(
    b.top.subscribe,
    () => mine(b.top)?.enabled,
    (e) => e?.join() === "pdf,review",
    "the folder's skill linked and switched on, on the other client",
  );
  assert.equal(skillsOf(b.top)?.shared.find((x) => x.name === "review")?.linkedFrom, pack);
  await assert.rejects(a.top.addSkillFolder("relative/path", []), /full path/);

  a.bot.send("/pdf fill in the form");
  const s = await untilBot(a.bot, (x) => settled(x) && ofKind(x, "user").some((u) => u.skill), "the message that used the skill");
  const used = ofKind(s, "user").find((u) => u.skill)!;
  assert.equal(used.text, "/pdf fill in the form");
  assert.deepEqual(used.skill, { name: "pdf", source: "shared", path: join(daemon.dataDir, "skills", "pdf", "SKILL.md") });

  await daemon.kill();
  await daemon.start();
  const c = new TopClient({ url: daemon.url });
  cleanup.push(() => c.close());
  const after = await until(
    c.subscribe,
    () => skillsOf(c)?.bots.find((x) => x.bot === a.id),
    (x) => !!x,
    "the skills after a restart",
  );
  assert.deepEqual(after!.enabled, ["pdf", "review"]);
});

test("no MCP server may take the name of Top's own tools (Collar)", async () => {
  const daemon = new Daemon();
  await daemon.start();
  const a = await connect(daemon, 0);
  const echo = resolve(import.meta.dirname, "../../../apps/server/test/fixtures/echo-mcp.mjs");
  await assert.rejects(
    a.top.saveMcpServer(undefined, " Collar! ", { transport: "stdio", command: process.execPath, args: [echo], env: [] }),
    /name of Top's own tools/,
  );
});

test("a bot's permission request reaches every client; the first answer wins, and what came of it syncs like any entry, across a restart", async () => {
  const daemon = new Daemon();
  await daemon.start();
  const a = await connect(daemon, 0);
  const b = await connect(daemon, 0);
  const waiting = (top: TopClient, n = 1) =>
    until(
      top.subscribe,
      () => top.getSnapshot().asks,
      (p) => p.length === n,
      `${n} waiting`,
    );
  const answerOf = (s: ConversationSnapshot, id: number) => ofKind(s, "answer").find((e) => e.request === id)?.answer;
  const target = (waiting: WaitingAsk | undefined) => ({ id: waiting!.ask.id, bot: waiting!.bot });

  a.bot.send("ask permission to rotate the API keys");
  const [waited] = await waiting(a.top);
  const request = target(waited);
  const ask = { kind: "permission", id: request.id, action: "rotate the API keys", reason: "You asked me to check with you first." };
  assert.deepEqual(waited, { bot: a.id, ask });
  let s = await untilBot(a.bot, (x) => settled(x) && ofKind(x, "tool").some((e) => e.ask), "the call's result");
  assert.deepEqual(ofKind(s, "tool").at(-1)!.ask, ask);
  assert.deepEqual((await waiting(b.top))[0], waited, "the other device sees the same request");

  const late = new TopClient({ url: daemon.url });
  cleanup.push(() => late.close());
  assert.equal((await waiting(late))[0]!.ask.id, request.id);

  await b.top.answerPermission(request, false);
  await assert.rejects(
    a.top.answerPermission(request, true),
    (error: Error) => error.name === "AskError" && /already answered/.test(error.message),
    "a later Allow is refused",
  );
  for (const top of [a.top, b.top, late]) await waiting(top, 0);
  for (const sync of [a.bot, b.bot]) await untilBot(sync, (x) => answerOf(x, request.id) === "denied", "the answer's entry");
  s = await untilBot(
    a.bot,
    (x) => settled(x) && ofKind(x, "user").filter((e) => e.source === "answer").length === 1 && ofKind(x, "assistant").length >= 3,
    "the bot's reply",
  );
  assert.equal(ofKind(s, "user").find((e) => e.source === "answer")!.text, "[Permission] The user denied: rotate the API keys. Don't do it.");

  a.bot.send("ask permission to purge the cache");
  const [secondWaiting] = await waiting(a.top);
  const second = target(secondWaiting);
  await untilBot(a.bot, (x) => ofKind(x, "tool").some((e) => e.ask?.id === second.id), "the second call's result");
  await daemon.kill();
  await until(
    a.top.subscribe,
    () => a.top.getSnapshot(),
    (x) => x.connection !== "open" && x.asks.length === 0,
    "the list dropped while offline: it can't be answered then",
  );
  await daemon.start();
  assert.deepEqual((await waiting(a.top))[0], secondWaiting, "still waiting after the restart");
  await a.top.answerPermission(second, true);
  s = await untilBot(
    a.bot,
    (x) => settled(x) && answerOf(x, second.id) === "allowed" && ofKind(x, "user").filter((e) => e.source === "answer").length === 2,
    "the second answer",
  );
  assert.equal(ofKind(s, "tool").filter((e) => e.ask).length, 2, "not asked again");

  a.bot.send("ask permission to reboot the router");
  const third = target((await waiting(a.top))[0]);
  await a.bot.abort();
  await waiting(a.top, 0);
  const fresh = new TopClient({ url: daemon.url });
  cleanup.push(() => fresh.close());
  await until(fresh.subscribe, fresh.getSnapshot, (x) => x.ready, "the roster");
  const reloaded = fresh.conversation(a.id);
  reloaded.retain();
  await untilBot(reloaded, (x) => x.status === "live" && answerOf(x, third.id) === "withdrawn", "the withdrawal, after a reload");
  assert.equal(ofKind(reloaded.getSnapshot(), "user").filter((e) => e.source === "answer").length, 2, "nothing reached the bot about it");
});

test("a secret goes from the card to a file only the bot's commands read: never into the conversation, the logs or the daemon's database", async () => {
  const daemon = new Daemon();
  await daemon.start();
  const a = await connect(daemon, 0);
  const asked = (n: number) =>
    until(
      a.top.subscribe,
      () => a.top.getSnapshot().asks,
      (p) => p.length === n,
      `${n} waiting`,
    );
  const secret = "tok_e2e_7f3a9c1d5b2e";

  a.bot.send("ask me for a token");
  const [waiting] = await asked(1);
  assert.equal(waiting!.ask.kind, "secret");
  assert.deepEqual(waiting!.ask, {
    kind: "secret",
    id: waiting!.ask.id,
    label: "Deploy token for staging",
    reason: "To push the build to staging.",
    placeholder: "tok_…",
    url: "https://example.com/settings/tokens",
  });
  await assert.rejects(a.top.saveSecret({ id: waiting!.ask.id, bot: a.id }, "   "), /Enter the secret first/);
  await a.top.saveSecret({ id: waiting!.ask.id, bot: a.id }, `  ${secret}\n`.trimEnd());
  await asked(0);
  const s = await untilBot(
    a.bot,
    (x) => settled(x) && ofKind(x, "tool").some((e) => e.name === "use_secret") && ofKind(x, "assistant").length >= 3,
    "the bot to use it",
  );
  const used = ofKind(s, "tool").find((e) => e.name === "use_secret")!;
  assert.equal(used.text, "Signed in to staging with [secret hidden by Top].", "a command that prints it shows the placeholder");
  assert.equal(ofKind(s, "answer").find((e) => e.request === waiting!.ask.id)?.answer, "saved");
  const told = ofKind(s, "user").find((e) => e.source === "answer")!.text;
  const path = /in the file (.+?)\. You never see/.exec(told)![1]!;
  assert.equal(readFileSync(path, "utf8"), secret, "the file holds it, trimmed");
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(join(path, "..")).mode & 0o777, 0o700);

  const everything = JSON.stringify(s) + daemon.output + readFileSync(join(daemon.dataDir, "server", "top.sqlite")).toString("latin1");
  assert.ok(!everything.includes(secret), "not in the conversation, the logs or the database");
  for (const wal of ["top.sqlite-wal", "top.sqlite-journal"]) {
    try {
      assert.ok(
        !readFileSync(join(daemon.dataDir, "server", wal))
          .toString("latin1")
          .includes(secret),
        wal,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
});

test("a bot's files have links once the daemon says where they are", async () => {
  const daemon = new Daemon();
  await daemon.start();
  const top = new TopClient({ url: daemon.url });
  cleanup.push(() => top.close());
  assert.equal(top.getSnapshot().hasFiles, false);
  assert.equal(top.fileUrl(1, "a.png"), undefined);
  await until(top.subscribe, top.getSnapshot, (s) => s.hasFiles && s.ready, "the files path");

  const bot = top.getSnapshot().bots[0]!;
  const folder = join(daemon.dataDir, "bots", bot.name, "files", "shots dir");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "inline narrow.png"), "png bytes");
  const response = await fetch(top.fileUrl(bot.id, "shots dir/inline narrow.png")!);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "png bytes");
  const other = top.getSnapshot().bots[1]!;
  assert.equal((await fetch(top.fileUrl(other.id, "shots dir/inline narrow.png")!)).status, 404);
});

test("a coding task leaves one fixed receipt where a new session starts; clients hear only its questions, never its progress", async () => {
  const daemon = new Daemon();
  await daemon.start();
  const frames: { t: string; tasks?: unknown }[] = [];
  class Recording extends WebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      this.addEventListener("message", (event) => frames.push(JSON.parse(String(event.data)) as { t: string }));
    }
  }
  const top = new TopClient({ url: daemon.url, WebSocket: Recording });
  cleanup.push(() => top.close());
  await until(top.subscribe, top.getSnapshot, (s) => s.ready, "the roster");
  const id = top.getSnapshot().bots[0]!.id;
  const bot = top.conversation(id);
  bot.retain();
  await untilBot(bot, (s) => s.status === "live", "the first sync");

  const starts = (s: ConversationSnapshot) => ofKind(s, "tool").filter((e) => e.name === "collar__task_start" && !e.isError);
  const told = (s: ConversationSnapshot) => ofKind(s, "user").filter((e) => e.source === "task").length;
  const waitingFrames = () => frames.filter((f) => f.t === "waitingTasks").map((f) => f.tasks);

  bot.send('call collar__task_start {"harness": "fake", "prompt": "build it", "title": "Build"}');
  let s = await untilBot(bot, (x) => told(x) === 1, "the first task to end");
  const [first] = starts(s);
  assert.match(first!.agent!.cwd, /bots/);
  assert.deepEqual(first!.agent, { title: "Build", harness: "Fake harness", cwd: first!.agent!.cwd });
  assert.deepEqual(waitingFrames(), [[]], "a task that only works and ends sends nothing to the app");
  const session = /"session":"(ses_\w+)"/.exec(first!.text)![1]!;

  bot.send(`call collar__task_start {"session": "${session}", "prompt": "a question"}`);
  const asked = await until(
    top.subscribe,
    () => top.getSnapshot().waitingTasks,
    (w) => w.length === 1,
    "the resumed task's question",
  );
  const [waiting] = asked;
  assert.equal(waiting!.bot, id);
  assert.deepEqual(
    waiting!.inputs[0]!.questions.map((q) => q.question),
    ["Which database?"],
  );
  s = await untilBot(bot, (x) => starts(x).length === 2, "the resumed start's result");
  assert.equal(starts(s)[1]!.agent, undefined, "carrying a session on adds no receipt");
  await top.answerTask(waiting!.id, waiting!.inputs[0]!.id, { db: ["SQLite"] });
  await until(
    top.subscribe,
    () => top.getSnapshot().waitingTasks,
    (w) => w.length === 0,
    "the question to go",
  );
  s = await untilBot(bot, (x) => told(x) >= 3, "the resumed task to end");

  bot.send(`call collar__task_start {"session": "${session}", "fork": true, "prompt": "branch it"}`);
  s = await untilBot(bot, (x) => told(x) >= 4, "the forked task to end");
  assert.equal(starts(s).length, 3);
  assert.ok(starts(s)[2]!.agent, "a branched session is a new agent, with its own receipt");
  assert.deepEqual(starts(s)[0]!.agent, first!.agent, "the first receipt never changed");
  assert.deepEqual(
    waitingFrames().map((w) => (w as unknown[]).length),
    [0, 1, 0],
    "only the question's arrival and its answer reached the app",
  );

  const fresh = new TopClient({ url: daemon.url });
  cleanup.push(() => fresh.close());
  await until(fresh.subscribe, fresh.getSnapshot, (x) => x.ready, "the roster");
  const reloaded = fresh.conversation(id);
  reloaded.retain();
  const again = await untilBot(reloaded, (x) => x.status === "live" && starts(x).length === 3, "the history after a reconnect");
  assert.deepEqual(
    starts(again).map((e) => e.agent),
    starts(s).map((e) => e.agent),
    "the receipts read back the same",
  );
});
