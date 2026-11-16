/**
 * End to end against the real daemon (Top's agent loop, SQLite storage, fake model with real tools),
 * killed with SIGKILL at the worst moments:
 *
 * - mid-answer, with a message sent while it was down: nothing lost, nothing doubled;
 * - mid-tool, for each recovery policy: a tool that may have taken effect is never run twice;
 * - in a crash loop: the task ends instead of restarting forever;
 * - a resent message is applied once; a long absence resumes with only the new entries plus a gap;
 * - a client that meets a different daemon on the same address drops what it held from the old one.
 */

import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll as after, test } from "vitest";
import { type BotSummary, type ConversationSnapshot, type ConversationSync, type Entry, TopClient } from "../src/index.ts";

const serverMain = resolve(import.meta.dirname, "../../../apps/server/src/main.ts");
const cleanup: (() => Promise<void> | void)[] = [];
after(async () => {
  for (const fn of cleanup.reverse()) await fn();
});

// Every daemon stays up until the suite ends, so give each its own port instead of a random one.
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

async function connect(daemon: Daemon, botIndex: number) {
  const top = new TopClient({ url: daemon.url });
  cleanup.push(() => top.close());
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

  // Optimistic: pending immediately, before any round trip.
  const sent = bot.send("hello from the e2e test");
  assert.equal(bot.getSnapshot().pending[0]!.requestId, sent.requestId);
  await untilBot(bot, (s) => s.pending.length === 0 && ofKind(s, "user").length === 1, "the message to land");
  await untilSummary(top, id, (b) => b.status === "thinking", "the bot to start answering");
  await new Promise((r) => setTimeout(r, 300));

  await daemon.kill();
  const stale = await untilBot(bot, (s) => s.status === "stale", "the stale state");
  assert.equal(ofKind(stale, "user").length, 1, "what we had stays on screen");

  // Sent while the daemon is down: shows as pending, goes out on reconnect.
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
      `${error.message}: ${JSON.stringify({ status: s.status, pending: s.pending, inbox: s.inbox, bot: b, entries: entries(s).map((e) => [e.seq, e.kind, e.kind === "files" ? e.files.length : e.kind === "user" ? e.text : e.text.slice(0, 30)]) })}\n${daemon.output.slice(-1500)}`,
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
  // The interrupted answer is simply asked again: one answer per message, no half answers.
  assert.equal(ofKind(done.s, "assistant").length, 2);
});

/** Ask for a tool, kill the daemon while it runs, restart, and return the settled transcript. */
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
  // The tool kills the daemon; every restart replays it (it says it's safe to), until the limit.
  for (; restarts < 8; restarts++) {
    await daemon.exited();
    if (daemon.output.includes("task ended")) break;
    await daemon.start().catch(() => {});
    await Promise.race([daemon.exited(), new Promise((r) => setTimeout(r, 3_000))]);
    if (daemon.process!.exitCode === null && daemon.process!.signalCode === null) break; // stayed up
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
  // No model request after the stop: the tool call, its stopped result, a note, then the next message.
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

  // Back with a warm cache and nothing new: the sync carries no entries at all.
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

  // Back after missing ~390 entries: the newest 50 and a gap, never the whole history.
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

  // Fresh data on the same port. Its sequence numbers start again from 1, below what the client holds.
  const b = new Daemon([], a.port);
  await b.start();
  await until(top.subscribe, top.getSnapshot, (x) => x.serverId !== aId && x.connection === "open", "the new daemon");
  await untilBot(bot, (x) => x.status === "live", "the fresh sync");
  assert.equal(entries(bot.getSnapshot()).length, 0, "nothing from the old daemon");

  bot.send("after the switch");
  const s = await untilBot(bot, (x) => ofKind(x, "assistant").length === 1, "the answer");
  assert.equal(entries(s)[0]!.kind, "user");
  assert.equal((entries(s)[0] as Extract<Entry, { kind: "user" }>).text, "after the switch", "the new message is first, not above old ones");

  // Its id survives a restart, so the client keeps what it has and resumes.
  const bId = top.getSnapshot().serverId;
  const held = entries(bot.getSnapshot()).length;
  await b.kill();
  await b.start();
  await until(top.subscribe, top.getSnapshot, (x) => x.connection === "open", "the restarted daemon");
  await untilBot(bot, (x) => x.status === "live", "the resumed sync");
  assert.equal(top.getSnapshot().serverId, bId);
  assert.equal(entries(bot.getSnapshot()).length, held);

  // Cold start from the old daemon's cache: dropped as soon as the new daemon says who it is.
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

  // The icon picked in the New bot dialog: every client gets it, and out-of-range ones are refused.
  const iconId = await a.top.createBot("Lark", "", 42);
  assert.equal(a.top.getSnapshot().bots.find((bot) => bot.id === iconId)?.avatar, 42);
  await untilSummary(b.top, iconId, (bot) => bot.avatar === 42, "the picked icon on the other client");
  await assert.rejects(a.top.createBot("Wren", "", -1), /icon doesn't exist/);
  await assert.rejects(a.top.createBot("Wren", "", 1.5), /Expected an integer/);
  await assert.rejects(a.top.createBot("Wren", "", 10_000), /icon doesn't exist/);

  // The new bot works like the first ones.
  const scout = a.top.conversation(id);
  scout.retain();
  await untilBot(scout, (s) => s.status === "live", "the new bot's first sync");
  scout.send("hello");
  await untilBot(scout, (s) => settled(s) && ofKind(s, "assistant").length === 1, "the new bot's answer");

  // Deleting a bot mid-task stops it and removes it everywhere.
  a.bot.send("deploy web 5s");
  await untilSummary(a.top, a.id, (bot) => bot.status === "tool", "the first bot running a tool");
  await a.top.deleteBot(a.id);
  assert.equal(
    a.top.getSnapshot().bots.some((bot) => bot.id === a.id),
    false,
  );
  await until(b.top.subscribe, b.top.getSnapshot, (s) => !s.bots.some((bot) => bot.id === a.id), "the deleted bot gone on the other client");
  await assert.rejects(a.top.deleteBot(a.id), /Unknown bot/);

  // After a restart: the new bot is still there, the deleted one isn't.
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

  // Deleting every bot doesn't bring the first ones back on the next start.
  for (const bot of roster) await c.deleteBot(bot.id);
  await daemon.kill();
  await daemon.start();
  const d = new TopClient({ url: daemon.url });
  cleanup.push(() => d.close());
  assert.equal((await until(d.subscribe, d.getSnapshot, (s) => s.ready, "the empty roster")).bots.length, 0);
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

  // Before it's assigned, the bot can't call it.
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

  // From its next message, it can: the call goes through the agent loop to the server and back.
  a.bot.send('call echo__echo {"text": "after"}');
  s = await untilBot(a.bot, (x) => settled(x) && ofKind(x, "assistant").length >= 4, "the assigned call");
  const result = ofKind(s, "tool").at(-1)!;
  assert.equal(result.name, "echo__echo");
  assert.equal(result.text, "echo: after");
  assert.equal(result.isError, undefined);

  // Assignments are kept across a restart, and the server reconnects by itself.
  await daemon.kill();
  await daemon.start();
  const c = new TopClient({ url: daemon.url });
  cleanup.push(() => c.close());
  const after = await ready(c);
  assert.deepEqual(after!.bots, [a.id]);

  await c.deleteMcpServer(id);
  await until(c.subscribe, c.getSnapshot, (s) => s.mcpServers.length === 0, "the server gone");
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

test("a bot's permission request reaches every client; the first answer wins, and a restart ends it unanswered", async () => {
  const daemon = new Daemon();
  await daemon.start();
  const a = await connect(daemon, 0);
  const b = await connect(daemon, 0);
  const asked = (top: TopClient) =>
    until(
      top.subscribe,
      () => top.getSnapshot().permissions,
      (p) => p.length === 1,
      "the request",
    );

  a.bot.send("ask permission to rotate the API keys");
  const [request] = await asked(a.top);
  assert.equal(request!.bot, a.id);
  assert.equal(request!.action, "rotate the API keys");
  assert.deepEqual((await asked(b.top))[0], request, "the other device sees the same request");

  // A client that connects (or reconnects) while it waits is sent it too.
  const late = new TopClient({ url: daemon.url });
  cleanup.push(() => late.close());
  assert.equal((await asked(late))[0]!.id, request!.id);

  await b.top.answerPermission(request!, false);
  await assert.rejects(a.top.answerPermission(request!, true), /already answered/, "a later Allow is refused");
  for (const top of [a.top, b.top, late])
    await until(
      top.subscribe,
      () => top.getSnapshot().permissions,
      (p) => p.length === 0,
      "the request gone",
    );
  let s = await untilBot(a.bot, (x) => settled(x) && ofKind(x, "assistant").length >= 2, "the bot's answer");
  assert.equal(ofKind(s, "tool").at(-1)!.text, "Denied by the user: rotate the API keys. Don't do it.");

  // Killed while a request waits: after the restart nobody is asked again, and the call says it got no answer.
  a.bot.send("ask permission to purge the cache");
  await asked(a.top);
  await daemon.kill();
  await until(
    a.top.subscribe,
    () => a.top.getSnapshot().permissions,
    (p) => p.length === 0,
    "the request cleared while offline",
  );
  await daemon.start();
  s = await untilBot(a.bot, (x) => settled(x) && ofKind(x, "tool").length >= 2 && ofKind(x, "assistant").length >= 4, "the bot after the restart");
  const cut = ofKind(s, "tool").at(-1)!;
  assert.equal(cut.outcome, "not_run");
  assert.doesNotMatch(cut.text, /Allowed/);
  assert.deepEqual(a.top.getSnapshot().permissions, [], "not asked again");
});
