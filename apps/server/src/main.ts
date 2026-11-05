/**
 * The Top daemon: owns one Pi Durable Harness on SQLite, runs the bots 24/7, and serves any number of
 * desktop and phone clients over one WebSocket each.
 *
 *   node --import tsx src/main.ts [--port 7357] [--data .data] [--load] [--reset] [--tps 100]
 */
import { rmSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { DEFAULT_PORT } from "@top/protocol";
import { createFakeModelProvider } from "./fake-bots.ts";
import { ensureBots, BotDirectory } from "./bots.ts";
import { startLoad } from "./load.ts";
import { seedHistory } from "./seed.ts";
import { serve } from "./serve.ts";

const { values: args } = parseArgs({
  options: {
    port: { type: "string", default: String(DEFAULT_PORT) },
    host: { type: "string", default: "127.0.0.1" },
    data: { type: "string", default: ".data" },
    load: { type: "boolean", default: false },
    reset: { type: "boolean", default: false },
    tps: { type: "string", default: "100" },
    seed: { type: "string", default: "0" },
  },
});

const context = BACKGROUND_CONTEXT;
const dataDir = resolve(args.data);
if (args.reset) rmSync(dataDir, { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true });

const models = createModels();
models.setProvider(createFakeModelProvider(Number(args.tps)).provider);

const harness = await Harness.open(
  await openNodeSqliteStorage(resolve(dataDir, "top.sqlite")),
  {
    models,
    registry: createRegistry(),
    identity: { attribution: null },
    // Stream partials to watchers every 50 ms (the default is 100 ms); storage still batches them.
    settings: { progress: { partialIntervalMs: 50 } },
    onReport: (report) => console.warn("[harness]", report),
  },
  context,
);
harness.closed.then((end) => {
  if (end.kind === "failed") {
    console.error("[harness] failed, exiting so a supervisor restarts us:", end.error);
    process.exit(1);
  }
});

const bots = await ensureBots(harness, context);
if (Number(args.seed) > 0) await seedHistory(harness, bots[0]!, Number(args.seed), context);
// Continue whatever the last process left unfinished: interrupted turns resume here.
harness.resume();

const directory = await BotDirectory.open(harness, bots, context);
const server = serve(harness, directory, { host: args.host, port: Number(args.port) });
const stopLoad = args.load ? startLoad(harness, bots) : () => {};

console.log(`[top] ${bots.length} bots, data in ${dataDir}`);
console.log(`[top] listening on ws://${args.host}:${args.port}${args.load ? " (synthetic load on)" : ""}`);

let closing = false;
async function shutdown(signal: string) {
  if (closing) process.exit(1);
  closing = true;
  console.log(`[top] ${signal}, closing`);
  stopLoad();
  await server.close();
  directory.close();
  await harness.close(context);
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
