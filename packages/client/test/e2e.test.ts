/**
 * End to end against the real daemon (real Pi Durable on SQLite, fake model):
 * optimistic send, streaming, kill -9 mid-turn, restart, resume without loss or duplicates.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { MESSAGE_KIND, TopClient, type ConversationSnapshot, type ConversationSync } from "../src/index.ts";

const serverMain = resolve(import.meta.dirname, "../../../apps/server/src/main.ts");
const dataDir = mkdtempSync(join(tmpdir(), "top-e2e-"));
const port = 7400 + Math.floor(Math.random() * 500);
let server: ChildProcess | undefined;

function startServer(): Promise<void> {
  return new Promise((resolveStart, reject) => {
    server = spawn(process.execPath, [serverMain, "--port", String(port), "--data", dataDir, "--tps", "60"], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    server.stdout!.on("data", (chunk: Buffer) => {
      if (String(chunk).includes("listening")) resolveStart();
    });
    server.on("exit", (code) => code && reject(new Error(`server exited ${code}`)));
  });
}

function killServer(): Promise<void> {
  return new Promise((r) => {
    if (!server || server.exitCode !== null) return r();
    server.once("exit", () => r());
    server.kill("SIGKILL");
  });
}

after(async () => {
  await killServer();
  rmSync(dataDir, { recursive: true, force: true });
});

function until(sync: ConversationSync, predicate: (s: ConversationSnapshot) => boolean, timeoutMs = 10_000) {
  return new Promise<ConversationSnapshot>((r, reject) => {
    const check = () => {
      const snapshot = sync.getSnapshot();
      if (predicate(snapshot)) {
        unsubscribe();
        clearTimeout(timer);
        r(snapshot);
      }
    };
    const unsubscribe = sync.subscribe(check);
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`timed out; last status ${sync.getSnapshot().status}`));
    }, timeoutMs);
    check();
  });
}

const messages = (s: ConversationSnapshot) =>
  s.items.filter((i) => i.kind === "entry" && i.entry.kind === MESSAGE_KIND);
const answers = (s: ConversationSnapshot) => s.items.filter((i) => i.kind === "entry" && i.entry.kind === "pi.assistant");
const streamedText = (s: ConversationSnapshot) =>
  ((s.live?.generation?.message as { content?: { type: string; text?: string }[] } | undefined)?.content ?? [])
    .map((c) => c.text ?? "")
    .join("");

test("send, crash mid-stream, resume", async () => {
  await startServer();
  const top = new TopClient({ url: `ws://127.0.0.1:${port}` });
  try {
    await new Promise<void>((r) => {
      const off = top.subscribe(() => top.getSnapshot().ready && (off(), r()));
    });
    const bot = top.conversation(top.getSnapshot().bots[0]!.id);
    bot.retain();
    await until(bot, (s) => s.status === "live");

    // Optimistic: pending immediately, before any round trip.
    const sent = bot.send("hello from the e2e test");
    assert.equal(bot.getSnapshot().pending.length, 1);
    assert.equal(bot.getSnapshot().pending[0]!.requestId, sent.requestId);

    // The real entry lands and retires the pending copy; the bot starts streaming.
    await until(bot, (s) => s.pending.length === 0 && messages(s).length === 1);
    await until(bot, (s) => streamedText(s).length > 20);

    // kill -9 mid-turn. The client goes stale but keeps what it had.
    await killServer();
    const stale = await until(bot, (s) => s.status === "stale");
    assert.equal(messages(stale).length, 1);

    // Sending while the daemon is down: shows as pending, goes out on reconnect.
    bot.send("sent while offline");
    assert.equal(bot.getSnapshot().pending.length, 1);

    await startServer();
    // Pi Durable resumes the interrupted turn; both messages answered exactly once.
    const done = await until(
      bot,
      (s) => s.status === "live" && s.pending.length === 0 && messages(s).length === 2 && !s.live?.run && answers(s).length >= 2,
      30_000,
    );
    const texts = messages(done).map((i) => (i.kind === "entry" ? (i.entry.data as { text: string }).text : ""));
    assert.deepEqual(texts, ["hello from the e2e test", "sent while offline"]);
    // Entry IDs strictly increase: nothing duplicated or reordered by the reconnect.
    const ids = done.items.flatMap((i) => (i.kind === "entry" ? [Number(i.entry.id)] : []));
    assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
    assert.equal(new Set(ids).size, ids.length);
  } finally {
    top.close();
  }
});
