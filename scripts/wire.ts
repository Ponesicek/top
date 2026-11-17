import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    tree: { type: "string", default: resolve(import.meta.dirname, "..") },
    seconds: { type: "string", default: "60" },
    "server-args": { type: "string", default: "" },
    json: { type: "boolean", default: false },
  },
});
const tree = resolve(args.tree);
const seconds = Number(args.seconds);
const require = createRequire(join(tree, "apps/server/package.json"));
const { WebSocket: WsWebSocket } = require("ws") as typeof import("ws");

type AnyClient = {
  subscribe(listener: () => void): () => void;
  getSnapshot(): { ready: boolean; bots: readonly { id: unknown }[] };
  conversation(id: unknown): AnyConversation;
  close(): void;
};
type AnyConversation = {
  retain(): void;
  subscribe(listener: () => void): () => void;
  getSnapshot(): { status: string; items: readonly { kind: string; entry?: { kind: string; seq?: number; id?: unknown } }[] };
  exportCache?(): unknown;
  hydrate(cache: unknown): void;
  exportView?(): unknown;
};
const { TopClient } = (await import(join(tree, "packages/client/src/index.ts"))) as { TopClient: new (o: { url: string; WebSocket: unknown }) => AnyClient };

function countingWebSocket() {
  const sockets: Socket[] = [];
  class Counting extends WsWebSocket {
    constructor(url: string) {
      super(url);
      this.once("upgrade", (response) => sockets.push(response.socket));
    }
  }
  return { WebSocket: Counting, bytes: () => sockets.reduce((sum, s) => sum + s.bytesRead + s.bytesWritten, 0) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function until(check: () => boolean, timeoutMs = 30_000): Promise<void> {
  return new Promise((r, reject) => {
    const start = Date.now();
    const tick = () => (check() ? r() : Date.now() - start > timeoutMs ? reject(new Error("timed out")) : setTimeout(tick, 20));
    tick();
  });
}

function answers(conversation: AnyConversation): Set<string> {
  const seen = new Set<string>();
  for (const item of conversation.getSnapshot().items) {
    const entry = item.entry;
    if (item.kind === "entry" && entry && (entry.kind === "assistant" || entry.kind === "pi.assistant")) seen.add(String(entry.seq ?? entry.id));
  }
  return seen;
}

async function startDaemon(extra: string[]): Promise<{ url: string; stop(): Promise<void> }> {
  const port = 7700 + Math.floor(Math.random() * 200);
  const dataDir = mkdtempSync(join(tmpdir(), "top-wire-"));
  const child: ChildProcess = spawn(
    process.execPath,
    ["--import", "tsx", join(tree, "apps/server/src/main.ts"), "--port", String(port), "--home", dataDir, ...extra],
    {
      stdio: ["ignore", "pipe", "inherit"],
      cwd: join(tree, "apps/server"),
    },
  );
  await new Promise<void>((r) => child.stdout!.on("data", (d: Buffer) => String(d).includes("listening") && r()));
  return {
    url: `ws://127.0.0.1:${port}`,
    stop: async () => {
      child.kill("SIGKILL");
      await new Promise((r) => child.once("exit", r));
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

async function connect(url: string) {
  const counter = countingWebSocket();
  const client = new TopClient({ url, WebSocket: counter.WebSocket });
  await until(() => client.getSnapshot().ready);
  return { client, bytes: counter.bytes };
}

const serverArgs = args["server-args"].split(" ").filter(Boolean);
const busy = await startDaemon(["--load", "--seed", "10000", "--tps", "100", ...serverArgs]);
const quiet = await startDaemon(["--tps", "100", ...serverArgs]);
const results: Record<string, { bytes: number; seconds?: number; answers?: number }> = {};

try {
  {
    const { client, bytes } = await connect(busy.url);
    const bot = client.conversation(client.getSnapshot().bots[0]!.id);
    bot.retain();
    await until(() => bot.getSnapshot().status === "live" && bot.getSnapshot().items.length > 0);
    await sleep(200);
    results.open = { bytes: bytes() };
    client.close();
  }

  const phase = async (name: string, url: string, follow: "one" | "all") => {
    const { client, bytes } = await connect(url);
    const ids = client.getSnapshot().bots.map((b) => b.id);
    const followed = (follow === "one" ? ids.slice(1, 2) : ids).map((id) => client.conversation(id));
    for (const c of followed) c.retain();
    await until(() => followed.every((c) => c.getSnapshot().status === "live"));
    const before = followed.map(answers);
    const start = bytes();
    await sleep(seconds * 1_000);
    const seen = followed.reduce((n, c, i) => n + [...answers(c)].filter((a) => !before[i]!.has(a)).length, 0);
    results[name] = { bytes: bytes() - start, seconds, answers: seen };
    client.close();
  };

  const resume = async () => {
    const first = await connect(busy.url);
    const id = first.client.getSnapshot().bots[1]!.id;
    const bot = first.client.conversation(id);
    bot.retain();
    await until(() => bot.getSnapshot().status === "live");
    await sleep(2_000);
    const cache = bot.exportCache ? bot.exportCache() : bot.exportView!();
    first.client.close();
    await sleep(30_000);
    const second = await connect(busy.url);
    const again = second.client.conversation(id);
    again.hydrate(cache);
    const before = answers(again);
    again.retain();
    await until(() => again.getSnapshot().status === "live");
    await sleep(200);
    results.resume = { bytes: second.bytes(), answers: [...answers(again)].filter((a) => !before.has(a)).length };
    second.client.close();
  };

  await Promise.all([phase("phone", busy.url, "one"), phase("desktop", busy.url, "all"), phase("idle", quiet.url, "all"), resume()]);
} finally {
  await busy.stop();
  await quiet.stop();
}

if (args.json) {
  console.log(JSON.stringify({ tree, seconds, serverArgs, results }));
} else {
  const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;
  console.log(`\n${tree}${serverArgs.length ? ` (${serverArgs.join(" ")})` : ""}`);
  console.log(`  open 10k-message bot, no cache   ${kb(results.open!.bytes)}`);
  for (const name of ["phone", "desktop", "idle"] as const) {
    const r = results[name]!;
    const perMin = (r.bytes / r.seconds!) * 60;
    console.log(`  ${name.padEnd(8)} ${kb(perMin).padStart(10)}/min   ${r.answers} answers   ${r.answers ? `${kb(r.bytes / r.answers)}/answer` : ""}`);
  }
  console.log(`  resume after 30 s away (cache)   ${kb(results.resume!.bytes)}   (${results.resume!.answers} new answers)`);
}
