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
import { claudeRuntime } from "../src/claudeRuntime.ts";
import * as Daemon from "../src/daemon.ts";
import * as Events from "../src/events.ts";
import { FAKE_MODEL, FAKE_PROVIDER, makeFakeModelProvider, type Context as RequestContext, type RequestOptions } from "../src/fake-bots.ts";
import type { FakeClaude } from "../src/fakeClaude.ts";
import * as Mcp from "../src/mcp.ts";
import * as Secrets from "../src/secrets.ts";
import { type ServeOptions, serve } from "../src/serve.ts";
import { LOCAL_SKILLS } from "../src/skills.ts";
import * as Sqlite from "../src/sqlite.ts";
import * as Store from "../src/store.ts";
import type { HarnessAdapter } from "../src/tasks/harness.ts";
import type { TopTool } from "../src/tools.ts";
import { botFolder } from "../src/workspace.ts";

const open: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const close of open.reverse()) await close();
});

export const MODEL = `${FAKE_PROVIDER}/${FAKE_MODEL}`;

export const BEFORE_ASKS = [
  "DROP TABLE asks",
  "CREATE TABLE permissions (id INTEGER PRIMARY KEY AUTOINCREMENT, bot INTEGER NOT NULL REFERENCES bots(id), key TEXT NOT NULL UNIQUE, action TEXT NOT NULL, reason TEXT, state TEXT NOT NULL DEFAULT 'pending', at INTEGER NOT NULL)",
  "CREATE INDEX permissions_pending ON permissions(state, bot)",
  "DELETE FROM effect_sql_migrations WHERE migration_id >= 8",
].join(";");

export const BEFORE_TASKS = [
  BEFORE_ASKS,
  "DROP TABLE task_events",
  "DROP TABLE task_messages",
  "DROP TABLE task_inputs",
  "DROP TABLE tasks",
  "DROP TABLE harness_sessions",
  "DELETE FROM effect_sql_migrations WHERE migration_id >= 7",
].join(";");

export const BEFORE_CONTEXT_FILES = [
  BEFORE_TASKS,
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
  readonly secretTtlMs?: number;
  readonly harnesses?: readonly HarnessAdapter[];
  /** Runs `claude/<model>` bots on this stand-in for the Agent SDK. */
  readonly claude?: FakeClaude;
  /** Each bot's model, by name, for bots this harness makes (default: the fake model). */
  readonly models?: Readonly<Record<string, string>>;
  readonly maxTasks?: number | undefined;
  readonly taskCancelGraceMs?: number;
  /** Wraps the store, to slow a write down or make it fail. */
  readonly store?: (store: Store.Store["Service"]) => Store.Store["Service"];
};

export const skillsConfig = (dir: string) => ({
  library: join(dir, "skills"),
  local: (bot: Pick<Store.BotRow, "name">) => join(dir, "bots", bot.name, LOCAL_SKILLS),
});

class Ports extends Context.Service<Ports, { readonly port: number; readonly tailnetPort: number | undefined }>()("test/Ports") {}

type Services = Store.Store | Events.Events | Daemon.Daemon | Daemon.BotKit | Secrets.Secrets;

export async function harness(options: HarnessOptions = {}) {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), "top-test-"));
  const stored = Store.layer.pipe(Layer.provide(Sqlite.layer({ filename: join(dir, "top.sqlite") })));
  const wrapped = options.store ? Layer.effect(Store.Store, Effect.map(Store.Store, options.store)).pipe(Layer.provide(stored)) : stored;
  const base = Layer.mergeAll(Events.layer, wrapped);
  const firstBots = Layer.effectDiscard(
    Effect.gen(function* () {
      const store = yield* Store.Store;
      if ((yield* store.bots).length === 0)
        for (const name of options.bots ?? ["Atlas"]) yield* store.createBot(name, options.models?.[name] ?? options.model?.id ?? MODEL);
    }),
  );
  const kit = Layer.effect(
    Daemon.BotKit,
    Effect.gen(function* () {
      const fake = createModels();
      if (!options.model) fake.setProvider((yield* makeFakeModelProvider(options.tps ?? 2_000, options.onRequest)).provider);
      const models = options.model?.models ?? fake;
      const store = yield* Store.Store;
      const claude = options.claude;
      return Daemon.BotKit.of({
        ...(claude
          ? {
              claude: {
                status: Effect.succeed({ ok: true as const, version: "2.1.330 (fake)" }),
                runtime: (bot: Store.BotRow) =>
                  claudeRuntime({
                    model: Effect.map(store.bot(bot.id), (row) => (row ?? bot).model.slice("claude/".length)),
                    cwd: botFolder(join(dir, "bots"), bot.name),
                    cli: async () => "/fake/claude",
                    sdk: async () => claude,
                    session: Effect.map(store.bot(bot.id), (row) => row?.session ?? null),
                    saveSession: (session: string) => store.setSession(bot.id, session),
                    spawn: () => {
                      throw new Error("the fake SDK spawns nothing");
                    },
                  }),
              },
            }
          : {}),
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
        harnesses: options.harnesses,
        maxTasks: options.maxTasks,
        taskCancelGraceMs: options.taskCancelGraceMs,
      });
    }),
  );
  const extras = Layer.mergeAll(
    options.attachments ? Attachments.layer(dir) : Layer.empty,
    options.mcp ? Mcp.layer({ oauthPort: 0 }) : Layer.empty,
    Secrets.layer(dir, options.secretTtlMs === undefined ? {} : { ttlMs: options.secretTtlMs }),
  );
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
    secrets: await run(Effect.service(Secrets.Secrets)),
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
