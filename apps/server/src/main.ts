/**
 * The Top daemon: runs the bots 24/7 on pi-agent-core with its own SQLite storage, and serves any
 * number of desktop and phone clients over one WebSocket each.
 *
 *   node --import tsx src/main.ts [--port 7357] [--data .data] [--load] [--tools] [--seed N] [--tps 100] [--reset] [--no-compress]
 */
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { createModels } from "@earendil-works/pi-ai/models";
import { DEFAULT_PORT } from "@top/protocol";
import { Daemon, ensureBots } from "./daemon.ts";
import { BOT_NAMES, createFakeModelProvider, FAKE_MODEL, FAKE_PROVIDER } from "./fake-bots.ts";
import { startLoad } from "./load.ts";
import { seedHistory } from "./seed.ts";
import { serve } from "./serve.ts";
import { Store } from "./store.ts";
import { createFakeTools } from "./tools.ts";

const { values: args } = parseArgs({
  options: {
    port: { type: "string", default: String(DEFAULT_PORT) },
    host: { type: "string", default: "127.0.0.1" },
    data: { type: "string", default: ".data" },
    load: { type: "boolean", default: false },
    tools: { type: "boolean", default: false },
    reset: { type: "boolean", default: false },
    tps: { type: "string", default: "100" },
    seed: { type: "string", default: "0" },
    "no-compress": { type: "boolean", default: false },
  },
});

const dataDir = resolve(args.data);
if (args.reset) rmSync(dataDir, { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true });

const models = createModels();
models.setProvider(createFakeModelProvider(Number(args.tps)).provider);
const tools = createFakeTools(resolve(dataDir, "effects.jsonl"));

const store = new Store(resolve(dataDir, "top.sqlite"));
ensureBots(store, BOT_NAMES, `${FAKE_PROVIDER}/${FAKE_MODEL}`, tools);
if (Number(args.seed) > 0) seedHistory(store, store.bots()[0]!.id, Number(args.seed));

const daemon = new Daemon(store, models, tools);
// Settle what the last process left unfinished (interrupted tool calls, half-done tasks), then run.
await daemon.start();

const server = serve(daemon, { host: args.host, port: Number(args.port), compress: !args["no-compress"] });
const stopLoad = args.load ? startLoad(daemon, { tools: args.tools }) : () => {};

console.log(`[top] ${daemon.runners.size} bots, data in ${dataDir}`);
console.log(`[top] listening on ws://${args.host}:${args.port}${args.load ? ` (synthetic load on${args.tools ? ", with tools" : ""})` : ""}`);

async function shutdown() {
  stopLoad();
  await server.close();
  store.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
