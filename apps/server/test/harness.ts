import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Models } from "@earendil-works/pi-ai";
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
import { botFolder } from "../src/workspace.ts";

const open: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const close of open.reverse()) await close();
});

export const MODEL = `${FAKE_PROVIDER}/${FAKE_MODEL}`;

export const BEFORE_CONTEXT_FILES = [
  "ALTER TABLE bots ADD COLUMN description TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE bots ADD COLUMN instructions TEXT NOT NULL DEFAULT ''",
  "DROP TABLE legacy_souls",
  "DELETE FROM effect_sql_migrations WHERE migration_id >= 6",
].join(";");

export type HarnessOptions = {
  readonly tools?: readonly TopTool[];
  readonly foregroundMs?: number;
  readonly gatherMs?: number;
  readonly repeatGapMs?: number;
  readonly compactAtTokens?: number;
  readonly dir?: string;
  readonly bots?: readonly string[];
  readonly files?: (bot: Store.BotRow) => string;
  readonly attachments?: boolean;
  readonly mcp?: boolean;
  readonly skills?: boolean;
  readonly serve?: Partial<ServeOptions>;
  readonly tps?: number;
  readonly onRequest?: (context: RequestContext, options: RequestOptions) => void;
  readonly model?: { readonly models: Models; readonly id: string };
  readonly webSearch?: boolean;
  readonly context?: boolean;
};

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
      if ((yield* store.bots).length === 0) for (const name of options.bots ?? ["Atlas"]) yield* store.createBot(name, options.model?.id ?? MODEL);
    }),
  );
  const kit = Layer.effect(
    Daemon.BotKit,
    Effect.gen(function* () {
      const fake = createModels();
      if (!options.model) fake.setProvider((yield* makeFakeModelProvider(options.tps ?? 2_000, options.onRequest)).provider);
      const models = options.model?.models ?? fake;
      return Daemon.BotKit.of({
        models,
        tools: options.tools ?? [],
        thinking: "off",
        newBot: { model: options.model?.id ?? MODEL, instructions: Daemon.DEFAULT_INSTRUCTIONS, declare: [] },
        ...(options.context ? { folder: (bot: Pick<Store.BotRow, "name">) => botFolder(join(dir, "bots"), bot.name) } : {}),
        files: options.files,
        ...(options.skills ? { skills: skillsConfig(dir) } : {}),
        foregroundMs: options.foregroundMs ?? 30_000,
        gatherMs: options.gatherMs,
        repeatGapMs: options.repeatGapMs,
        compactAtTokens: options.compactAtTokens,
        retryDelaysMs: [100, 100, 100],
        webSearch: options.webSearch,
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
    entries: (bot = bots[0]!) => run(store.after(bot, 0, 1_000)),
    close,
  };
}

export type Harness = Awaited<ReturnType<typeof harness>>;

export async function until<T>(what: string, check: () => T | undefined | false | Promise<T | undefined | false>, timeoutMs = 5_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export const idle = async (h: Harness, bot = h.bot) => {
  const runner = await h.run(h.daemon.runner(bot));
  return !runner.busy() && (await h.run(h.store.inbox(bot))).length === 0;
};
