// A daemon with one Claude bot on the real Agent SDK and the real Claude Code CLI, for real-claude-bot.test.ts to
// kill and start again. Usage: claude-bot-daemon.ts <dir> <phase: first | resume> [message…]
// It prints one JSON line per event: {"started": true}, {"entries": [...], "status": ...} when idle.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import Type from "typebox";
import { claudeCli, claudeRuntime, realSdk } from "../../src/claudeRuntime.ts";
import * as Daemon from "../../src/daemon.ts";
import * as Events from "../../src/events.ts";
import * as Secrets from "../../src/secrets.ts";
import * as Sqlite from "../../src/sqlite.ts";
import * as Store from "../../src/store.ts";
import { fromPromise, type TopTool, text } from "../../src/tools.ts";
import { botFolder } from "../../src/workspace.ts";

const [dir, phase, ...messages] = process.argv.slice(2) as [string, "first" | "resume", ...string[]];
const runs = join(dir, "deploy-runs.log");
const say = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);

const deploy: TopTool = {
  name: "deploy",
  label: "Deploy",
  description: "Deploys the service to a target. It takes a while. It must never run twice for one request.",
  parameters: Type.Object({ target: Type.String({ description: "Where to deploy" }) }),
  run: (args) =>
    fromPromise(() => {
      appendFileSync(runs, `${String(args.target)}\n`);
      say({ deployStarted: String(args.target) });
      // The first daemon dies while this runs; were it ever called again, it would finish.
      return phase === "first" ? new Promise(() => {}) : Promise.resolve(text(`deployed to ${String(args.target)}`));
    }),
};
const echo: TopTool = {
  name: "echo",
  label: "Echo",
  description: "Returns its text, reversed.",
  parameters: Type.Object({ text: Type.String() }, { additionalProperties: false }),
  run: (args) => Effect.succeed(text([...String(args.text)].reverse().join(""))),
};

const stored = Store.layer.pipe(Layer.provide(Sqlite.layer({ filename: join(dir, "top.sqlite") })));
const cli = claudeCli();
const kit = Layer.effect(
  Daemon.BotKit,
  Effect.gen(function* () {
    const store = yield* Store.Store;
    const models = createModels();
    return Daemon.BotKit.of({
      models,
      tools: [deploy, echo],
      thinking: "low",
      newBot: { model: "fake/none", instructions: Daemon.DEFAULT_INSTRUCTIONS, declare: [] },
      folder: (bot) => botFolder(join(dir, "bots"), bot.name),
      foregroundMs: 600_000,
      claude: {
        status: Effect.promise(cli.status),
        runtime: (bot) =>
          claudeRuntime({
            model: Effect.map(store.bot(bot.id), (row) => (row ?? bot).model.slice("claude/".length)),
            cwd: botFolder(join(dir, "bots"), bot.name),
            cli: cli.locate,
            sdk: realSdk,
            session: Effect.map(store.bot(bot.id), (row) => row?.session ?? null),
            saveSession: (session) => store.setSession(bot.id, session),
          }),
      },
    });
  }),
);
const daemon = Daemon.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(kit, Secrets.layer(dir, {}))),
  Layer.provideMerge(Layer.mergeAll(Events.layer, stored)),
  Layer.provideMerge(NodeServices.layer),
);
const runtime = ManagedRuntime.make(daemon);
const run = <A, E>(effect: Effect.Effect<A, E, Store.Store | Daemon.Daemon>) => runtime.runPromise(effect as never) as Promise<A>;

const main = async () => {
  const store = await run(Effect.service(Store.Store));
  const d = await run(Effect.service(Daemon.Daemon));
  let bot = (await run(store.bots)).find((b) => b.name === "Quill")?.id;
  if (bot === undefined) {
    bot = await run(d.createBot("Quill", "A terse test bot.", 0, "claude/haiku"));
    if (process.env.TOP_TEST_USER_MD) writeFileSync(join(botFolder(join(dir, "bots"), "Quill"), "USER.md"), process.env.TOP_TEST_USER_MD);
  }
  await run(d.start);
  say({ started: true, bot, session: (await run(store.bot(bot)))!.session });
  const runner = await run(d.runner(bot));
  const settle = async () => {
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (runner.busy() || (await run(store.inbox(bot))).length) continue;
      const entries = await run(store.after(bot, 0, 1_000));
      say({
        idle: true,
        status: runner.status(),
        session: (await run(store.bot(bot)))!.session,
        deployRuns: readFileSync(runs, { encoding: "utf8", flag: "a+" }).split("\n").filter(Boolean).length,
        entries: entries.map((e) => ({ kind: e.kind, outcome: "outcome" in e ? e.outcome : undefined, message: e.message })),
      });
      return;
    }
  };
  // A restarted daemon carries on the cut-off turn by itself.
  if (phase === "resume") await settle();
  let n = 0;
  for (const message of messages) {
    await run(d.submit(bot, `${phase}-${++n}`, message, "followUp", null));
    await settle();
  }
  await runtime.dispose();
};
main().catch((error) => {
  say({ error: String(error) });
  process.exit(1);
});
