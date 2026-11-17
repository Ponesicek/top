/**
 * A daemon for a test: the real services (store, events, bots, and optionally attachments, MCP servers
 * and the HTTP server) on a fresh data folder, run by one `ManagedRuntime`. Tests talk to it through
 * the services' own Effects (`h.run(...)`), and everything closes after the file's tests.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { afterAll } from "vitest";
import * as Attachments from "../src/attachments.ts";
import * as Daemon from "../src/daemon.ts";
import * as Events from "../src/events.ts";
import { FAKE_MODEL, FAKE_PROVIDER, makeFakeModelProvider, type Context as RequestContext, type RequestOptions } from "../src/fake-bots.ts";
import * as Mcp from "../src/mcp.ts";
import { type ServeOptions, serve } from "../src/serve.ts";
import { LOCAL_SKILLS } from "../src/skills.ts";
import * as Sqlite from "../src/sqlite.ts";
import * as Store from "../src/store.ts";
import type { TopTool } from "../src/tools.ts";

const open: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const close of open.reverse()) await close();
});

export const MODEL = `${FAKE_PROVIDER}/${FAKE_MODEL}`;

export type HarnessOptions = {
  readonly tools?: readonly TopTool[];
  readonly foregroundMs?: number;
  readonly gatherMs?: number;
  /** The least time between two runs of a repeating background call. */
  readonly repeatGapMs?: number;
  /** Compact a bot's transcript when it's longer than this many tokens. */
  readonly compactAtTokens?: number;
  /** An existing data folder: a daemon starting again on the last one's data. */
  readonly dir?: string;
  /** The bots a fresh store starts with. */
  readonly bots?: readonly string[];
  readonly files?: (bot: Store.BotRow) => string;
  readonly attachments?: boolean;
  readonly mcp?: boolean;
  /** Bots have skills: the shared library is `<dir>/skills`, a bot's own are `<dir>/bots/<name>/.agents/skills`. */
  readonly skills?: boolean;
  /** Also listen over HTTP and WebSocket (port 0 picks a free one). */
  readonly serve?: Partial<ServeOptions>;
  readonly tps?: number;
  /** Sees every model request the bots make. */
  readonly onRequest?: (context: RequestContext, options: RequestOptions) => void;
};

/** Where a test daemon's skills are (see `HarnessOptions.skills`). */
export const skillsConfig = (dir: string) => ({
  library: join(dir, "skills"),
  local: (bot: Pick<Store.BotRow, "name">) => join(dir, "bots", bot.name, LOCAL_SKILLS),
});

class Ports extends Context.Service<Ports, { readonly port: number; readonly tailnetPort: number | undefined }>()("test/Ports") {}

type Services = Store.Store | Events.Events | Daemon.Daemon | Daemon.BotKit;

export async function harness(options: HarnessOptions = {}) {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), "top-test-"));
  const base = Layer.mergeAll(Events.layer, Store.layer.pipe(Layer.provide(Sqlite.layer({ filename: join(dir, "top.sqlite") }))));
  const firstBots = Layer.effectDiscard(
    Effect.gen(function* () {
      const store = yield* Store.Store;
      if ((yield* store.bots).length === 0) for (const name of options.bots ?? ["Atlas"]) yield* store.createBot(name, "", MODEL);
    }),
  );
  const kit = Layer.effect(
    Daemon.BotKit,
    Effect.gen(function* () {
      const models = createModels();
      models.setProvider((yield* makeFakeModelProvider(options.tps ?? 2_000, options.onRequest)).provider);
      return Daemon.BotKit.of({
        models,
        tools: options.tools ?? [],
        thinking: "off",
        // Bots can be made from a test like from the app (the first ones are made above, without a system message).
        newBot: { model: MODEL, instructions: Daemon.defaultInstructions, declare: [] },
        files: options.files,
        ...(options.skills ? { skills: skillsConfig(dir) } : {}),
        foregroundMs: options.foregroundMs ?? 30_000,
        gatherMs: options.gatherMs,
        repeatGapMs: options.repeatGapMs,
        compactAtTokens: options.compactAtTokens,
        retryDelaysMs: [100, 100, 100],
      });
    }),
  );
  const extras = Layer.mergeAll(options.attachments ? Attachments.layer(dir) : Layer.empty, options.mcp ? Mcp.layer({ oauthPort: 0 }) : Layer.empty);
  const daemon = Daemon.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(kit, extras, firstBots)),
    Layer.provideMerge(base),
    Layer.provideMerge(NodeServices.layer),
  );
  const served = options.serve
    ? Layer.effect(Ports, serve({ host: "127.0.0.1", port: 0, compress: false, ...options.serve })).pipe(Layer.provideMerge(daemon))
    : Layer.merge(daemon, Layer.succeed(Ports, { port: 0, tailnetPort: undefined }));
  const runtime = ManagedRuntime.make(served);
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await runtime.dispose();
  };
  open.push(async () => {
    await close();
    if (!options.dir) rmSync(dir, { recursive: true, force: true });
  });

  // Attachments and MCP servers exist only when asked for: a test that uses them without asking fails.
  const run = <A, E>(effect: Effect.Effect<A, E, Services | Attachments.Attachments | Mcp.Mcp | NodeServices.NodeServices>): Promise<A> =>
    runtime.runPromise(effect as never);
  const store = await run(Effect.service(Store.Store));
  const ports = await runtime.runPromise(Effect.service(Ports));
  const bots = (await run(store.bots)).map((b) => b.id);
  return {
    dir,
    run,
    store,
    daemon: await run(Effect.service(Daemon.Daemon)),
    events: await run(Effect.service(Events.Events)),
    attachments: options.attachments ? await run(Effect.service(Attachments.Attachments)) : undefined,
    mcp: options.mcp ? await run(Effect.service(Mcp.Mcp)) : undefined,
    port: ports.port,
    tailnetPort: ports.tailnetPort,
    bot: bots[0]!,
    bots,
    /** Every entry of a bot clients see, oldest first. */
    entries: (bot = bots[0]!) => run(store.after(bot, 0, 1_000)),
    /** Stop this daemon (its data folder stays until the file's tests end). */
    close,
  };
}

export type Harness = Awaited<ReturnType<typeof harness>>;

/** Poll `check` (which may read the store) until it gives a value. */
export async function until<T>(what: string, check: () => T | undefined | false | Promise<T | undefined | false>, timeoutMs = 5_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** The bot has nothing running and nothing waiting. */
export const idle = async (h: Harness, bot = h.bot) => {
  const runner = await h.run(h.daemon.runner(bot));
  return !runner.busy() && (await h.run(h.store.inbox(bot))).length === 0;
};
