/**
 * The Top daemon: runs the bots 24/7 on pi-agent-core with its own SQLite storage, and serves any
 * number of desktop and phone clients over one WebSocket each.
 *
 *   node --import tsx src/main.ts --model openai/gpt-6.1-sol [--thinking medium] [--workspace ~]   real bots
 *   node --import tsx src/main.ts [--load] [--tools] [--seed N] [--tps 100]          fake bots
 *   common: [--port 7357] [--host 127.0.0.1] [--data DIR] [--reset] [--no-compress]
 *
 * With `--model`, the bots run on that model, signed in through pi's credentials (see auth.ts) or an
 * API key in the environment. Each works in its own folder, `<workspace>/bots/<name>`, with full access
 * to the computer (see workspace.ts). Without it they run on a scripted fake model with fake tools, for
 * development, tests and benchmarks.
 */
import { mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { createModels, type MutableModels } from "@earendil-works/pi-ai/models";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { DEFAULT_PORT } from "@top/protocol";
import { PiAuthFile } from "./auth.ts";
import { Daemon, defaultInstructions, ensureBots, type NewBot, purpose } from "./daemon.ts";
import { BOT_NAMES, createFakeModelProvider, FAKE_MODEL, FAKE_PROVIDER } from "./fake-bots.ts";
import { startLoad } from "./load.ts";
import { McpManager } from "./mcp.ts";
import { seedHistory } from "./seed.ts";
import { serve } from "./serve.ts";
import { type BotRow, Store } from "./store.ts";
import { createFakeTools, type TopTool } from "./tools.ts";
import { botFolder, computerTools, ensureFolder, FILES_FOLDER, workspaceSection } from "./workspace.ts";

const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

const { values: args } = parseArgs({
  options: {
    model: { type: "string" },
    thinking: { type: "string", default: "medium" },
    workspace: { type: "string" },
    "allow-origin": { type: "string", multiple: true },
    port: { type: "string", default: String(DEFAULT_PORT) },
    host: { type: "string", default: "127.0.0.1" },
    data: { type: "string" },
    load: { type: "boolean", default: false },
    tools: { type: "boolean", default: false },
    reset: { type: "boolean", default: false },
    tps: { type: "string", default: "100" },
    seed: { type: "string", default: "0" },
    "no-compress": { type: "boolean", default: false },
  },
});

function fail(message: string): never {
  console.error(`[top] ${message}`);
  process.exit(1);
}

const real = args.model !== undefined;
if (real && (args.load || args.tools || Number(args.seed) > 0)) {
  fail("--load, --tools and --seed drive the fake bots; they can't be combined with --model.");
}
if (!real && args.workspace) fail("--workspace is for real bots (--model); the fake ones don't touch the computer.");
// Where the bots' folders go: <workspace>/bots/<name>.
const workspace = resolve((args.workspace ?? homedir()).replace(/^~(?=$|\/)/, homedir()));
const thinking = args.thinking as ThinkingLevel;
if (!THINKING_LEVELS.includes(thinking)) fail(`--thinking must be one of ${THINKING_LEVELS.join(", ")}.`);

// Real and fake bots keep separate data, so trying the fake ones never touches real transcripts.
const dataDir = resolve(args.data ?? (real ? ".data/bots" : ".data/fake"));
if (args.reset) rmSync(dataDir, { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true });

let models: MutableModels;
let model: string;
let tools: TopTool[] | ((bot: BotRow) => TopTool[]);
let sections: ((bot: BotRow) => Record<string, string>) | undefined;
let instructionsFor: (name: string, description: string) => string = defaultInstructions;
let botNames: readonly string[];
/** Each bot's files folder: inside its working folder for real bots, in the data folder for fake ones. */
let filesOf: (bot: BotRow) => string;

if (real) {
  model = args.model!;
  const slash = model.indexOf("/");
  if (slash <= 0) fail(`--model takes provider/model-id, e.g. openai/gpt-6.1-sol (got "${model}").`);
  const providerId = model.slice(0, slash);
  const credentials = new PiAuthFile();
  models = builtinModels({ credentials });
  if (!models.getProvider(providerId))
    fail(
      `Unknown provider "${providerId}". Known: ${models
        .getProviders()
        .map((p) => p.id)
        .join(", ")}.`,
    );
  const auth = await models.checkAuth(providerId);
  if (!auth)
    fail(
      `Not signed in to ${providerId}. Run \`pi\`, then \`/login\` (Top shares pi's ${credentials.path}), or set the provider's API key in the environment.`,
    );
  if (!models.getModel(providerId, model.slice(slash + 1))) {
    await models.refresh({ providers: [providerId] });
    if (!models.getModel(providerId, model.slice(slash + 1))) fail(`${providerId} has no model "${model.slice(slash + 1)}".`);
  }
  console.log(`[top] model ${model} (${auth.source ?? auth.type}), thinking ${thinking}`);
  // One bot to start with; the app makes more.
  botNames = ["Atlas"];
  // Each bot works in a folder it owns, with pi's tools over the whole computer. The tools are
  // declared to the model on its next request, and the workspace section with its next message.
  const folderOf = (bot: BotRow) => ensureFolder(botFolder(workspace, bot.name));
  filesOf = (bot) => join(botFolder(workspace, bot.name), FILES_FOLDER);
  tools = (bot) => computerTools(folderOf(bot));
  sections = (bot) => {
    const prompt = getCurrentSystemPrompt(store.context(bot.id).map((e) => e.message) as never);
    return { workspace: workspaceSection(folderOf(bot), prompt.includes("You have no tools yet")) };
  };
  instructionsFor = (name, description) =>
    [
      `You are ${name}, one of the user's bots, running in Top: a daemon that keeps you running 24/7 while the user's desktop and phone apps attach and detach.`,
      ...(description ? [purpose(description)] : []),
      "Your answers arrive whole, not streamed, often on a phone, so lead with the answer and keep it tight. Use Markdown where it helps.",
    ].join("\n");
} else {
  model = `${FAKE_PROVIDER}/${FAKE_MODEL}`;
  models = createModels();
  models.setProvider(createFakeModelProvider(Number(args.tps)).provider);
  filesOf = (bot) => join(botFolder(dataDir, bot.name), FILES_FOLDER);
  tools = createFakeTools(resolve(dataDir, "effects.jsonl"), (id) => {
    const bot = store.bot(id);
    return bot && filesOf(bot);
  });
  botNames = BOT_NAMES;
}

const store = new Store(resolve(dataDir, "top.sqlite"));
// Real bots' tools are declared on their first request, so their first system message holds only instructions.
const newBot: NewBot = { model, instructions: instructionsFor, declare: typeof tools === "function" ? [] : tools };
ensureBots(store, botNames, newBot);
// One model for every bot for now; switching `--model` moves the existing bots over.
for (const bot of store.bots()) if (bot.model !== model) store.setModel(bot.id, model);
const seeded = store.bots()[0];
if (Number(args.seed) > 0 && seeded) seedHistory(store, seeded.id, Number(args.seed));

// MCP servers set up in the app. Signing in to one redirects to the port after the daemon's.
const mcp = new McpManager(store, { oauthPort: Number(args.port) + 1, clientInfo: { name: "Top", version: "0.0.0" } });
mcp.start();
const daemon = new Daemon(store, models, tools, { thinking: real ? thinking : "off", newBot, mcp, files: filesOf, ...(sections ? { sections } : {}) });
// Settle what the last process left unfinished (interrupted tool calls, half-done tasks), then run.
await daemon.start();

const server = serve(daemon, { host: args.host, port: Number(args.port), compress: !args["no-compress"], allowOrigins: args["allow-origin"] ?? [] });
await server.listening.catch((error: Error) => fail(`can't listen on ${args.host}:${args.port}: ${error.message}`));
const stopLoad = args.load ? startLoad(daemon, { tools: args.tools }) : () => {};

console.log(
  `[top] ${daemon.runners.size} bot${daemon.runners.size === 1 ? "" : "s"}, data in ${dataDir}${real ? `, working in ${resolve(workspace, "bots")}` : ""}`,
);
console.log(`[top] listening on ws://${args.host}:${args.port}${args.load ? ` (synthetic load on${args.tools ? ", with tools" : ""})` : ""}`);

async function shutdown() {
  stopLoad();
  await server.close();
  // Stops the MCP servers' programs too.
  await mcp.close();
  daemon.close();
  store.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
