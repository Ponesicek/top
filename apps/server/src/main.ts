import { join, resolve } from "node:path";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { DEFAULT_PORT } from "@top/protocol";
import type * as Config from "effect/Config";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Attachments from "./attachments.ts";
import { AuthFile } from "./auth.ts";
import { BUILD } from "./build.ts";
import * as ChatGPT from "./chatgpt.ts";
import { CompactAtTokens } from "./compaction.ts";
import * as Daemon from "./daemon.ts";
import * as Events from "./events.ts";
import { BOT_NAMES, FAKE_MODEL, FAKE_PROVIDER, makeFakeModelProvider } from "./fake-bots.ts";
import * as Home from "./home.ts";
import { DEFAULT_MODEL, install, installLayout } from "./installation.ts";
import { ForegroundMs } from "./jobs.ts";
import { startLoad } from "./load.ts";
import * as Logger from "./logger.ts";
import { signInHere, signOutHere } from "./login.ts";
import type { ThinkingLevel } from "./loop.ts";
import * as Mcp from "./mcp.ts";
import { RetryDelaysMs } from "./runner.ts";
import * as Secrets from "./secrets.ts";
import { serve } from "./serve.ts";
import { LOCAL_SKILLS } from "./skills.ts";
import * as Sqlite from "./sqlite.ts";
import * as Store from "./store.ts";
import { t3Connect, t3Disconnect, t3Status } from "./t3cli.ts";
import * as T3Link from "./t3link.ts";
import { connectTailnet, systemCli, TAILNET_PORT, type Tailnet } from "./tailscale.ts";
import { claudeAdapter } from "./tasks/claude.ts";
import { claudeCloudAdapter } from "./tasks/claudecloud.ts";
import { codexAdapter } from "./tasks/codex.ts";
import { codexCloudAdapter } from "./tasks/codexcloud.ts";
import { fakeHarness } from "./tasks/fake.ts";
import { readT3Config } from "./tasks/t3api.ts";
import { t3codeAdapter } from "./tasks/t3code.ts";
import { makeFakeTools } from "./tools.ts";
import * as Updates from "./updates.ts";
import { canSearchTheWeb } from "./websearch.ts";
import { botFolder, computerTools, ensureFolder, FILES_FOLDER, workspaceSection } from "./workspace.ts";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly ThinkingLevel[];

class StartError extends Data.TaggedError("StartError")<{ readonly message: string }> {}

const QUOTES_SECTION = [
  "<quotes>",
  "The user can quote passages of your earlier answers. A quote appears in their message as a link: [Quote](top-quote://v1/<seq>?text=<passage>&comment=<comment>), URL-encoded (+ is a space).",
  "`text` is the passage they quoted from your answer, `seq` that answer's entry number, and `comment`, when present, what they say about that passage specifically. The text around the links is the rest of their message; where they put each quote in it matters.",
  "</quotes>",
].join("\n");

const WAITING_SECTION = [
  "<waiting>",
  "Every turn you take reads this whole conversation again, and the user pays for each one. Take turns to act, not to check on things.",
  "- To wait for another agent or a long task, run its wait tool through collar__background with `repeat_while` set to what its result says while the work is still going (for example '\"timedOut\":true'), then end your turn. You get one message, when it's done.",
  "- Set wake-ups for things due at a time, such as a reminder or a deadline, not to see whether work is finished.",
  "- Coding tasks you hand to a harness (collar__task_start) message you when they end or need your answer: don't wait on them or poll them.",
  "- Something that can't tell you when it's done: check it at most every 30 minutes.",
  "</waiting>",
].join("\n");

const last = <A>(flag: Flag.Flag<A>, fallback: A) =>
  flag.pipe(
    Flag.atLeast(0),
    Flag.map((values) => (values.length ? values[values.length - 1]! : fallback)),
  );
const lastOptional = <A>(flag: Flag.Flag<A>) =>
  flag.pipe(
    Flag.atLeast(0),
    Flag.map((values) => Option.fromNullishOr(values.at(-1))),
  );
const toggle = (name: string, fallback: boolean) => last(Flag.Boolean(name), fallback);

const maxTasks = () => {
  const value = Number.parseInt(process.env.TOP_MAX_TASKS ?? "", 10);
  return Number.isInteger(value) && value > 0 ? value : undefined;
};

const flags = {
  model: lastOptional(Flag.String("model").pipe(Flag.withDescription("Run real bots on this model: provider/model-id"))),
  thinking: last(Flag.Literals("thinking", THINKING_LEVELS), "medium"),
  allowOrigin: Flag.String("allow-origin").pipe(Flag.atLeast(0)),
  port: last(Flag.Int("port"), DEFAULT_PORT),
  host: last(Flag.String("host"), "127.0.0.1"),
  home: lastOptional(Flag.String("home").pipe(Flag.withDescription("Keep everything here (default $TOP_HOME or ~/.top; fake bots: .data/fake)"))),
  load: toggle("load", false),
  tools: toggle("tools", false),
  reset: toggle("reset", false),
  tps: last(Flag.Int("tps"), 100),
  seed: last(Flag.Int("seed"), 0),
  compress: toggle("compress", true),
  tailscale: toggle("tailscale", false),
  tailscaleAllow: Flag.String("tailscale-allow").pipe(Flag.atLeast(0)),
  tailscalePort: last(Flag.Int("tailscale-port"), TAILNET_PORT),
};

type Args = Command.Command.Config.Infer<typeof flags>;

const skillsOf = (home: Home.Layout) => ({ library: home.skills, local: (bot: Store.BotRow) => join(botFolder(home.bots, bot.name), LOCAL_SKILLS) });

const realBots = (args: Args, model: string, home: Home.Layout) =>
  Effect.gen(function* () {
    const slash = model.indexOf("/");
    if (slash <= 0) return yield* new StartError({ message: `--model takes provider/model-id, e.g. openai/gpt-6.2-sol (got "${model}").` });
    const providerId = model.slice(0, slash);
    const fs = yield* FileSystem.FileSystem;
    const credentials = new AuthFile(home.auth, fs);
    const models = builtinModels({ credentials });
    if (!models.getProvider(providerId))
      return yield* new StartError({
        message: `Unknown provider "${providerId}". Known: ${models
          .getProviders()
          .map((p) => p.id)
          .join(", ")}.`,
      });
    const auth = yield* Effect.promise(() => models.checkAuth(providerId).catch(() => undefined));
    if (!auth && providerId !== ChatGPT.CHATGPT_PROVIDER)
      return yield* new StartError({ message: `Not signed in to ${providerId}. Set the provider's API key in the environment.` });
    if (!auth) yield* Effect.logWarning("Not signed in: sign in with ChatGPT in the app's Settings, or run `top login`. The bots can't answer until then.");
    if (!models.getModel(providerId, model.slice(slash + 1))) {
      yield* Effect.promise(() => models.refresh({ providers: [providerId] }).catch(() => undefined));
    }
    const found = models.getModel(providerId, model.slice(slash + 1));
    if (!found) return yield* new StartError({ message: `${providerId} has no model "${model.slice(slash + 1)}".` });
    yield* Effect.log(`model ${model} (${auth ? (auth.source ?? auth.type) : "not signed in"}), thinking ${args.thinking}`);
    // T3 Code is offered while Top is paired with one (Settings → T3 Code, or `top t3code connect`); its credential is read again for each task.
    const t3 = yield* Effect.promise(() => readT3Config(home.t3code).catch(() => undefined));
    if (t3) yield* Effect.log(`T3 Code at ${t3.url} (${t3.label})`);
    const kit = Layer.effect(
      Daemon.BotKit,
      Effect.gen(function* () {
        const store = yield* Store.Store;
        const secrets = yield* Secrets.Secrets;
        const folderOf = (bot: Store.BotRow) => ensureFolder(botFolder(home.bots, bot.name)).pipe(Effect.provideService(FileSystem.FileSystem, fs));
        return Daemon.BotKit.of({
          models,
          tools: (bot) => Effect.map(folderOf(bot), (folder) => computerTools(folder, secrets.outputHider)),
          thinking: args.thinking,
          sections: (bot) =>
            Effect.gen(function* () {
              const prompt = getCurrentSystemPrompt(yield* store.context(bot.id));
              return {
                workspace: workspaceSection(yield* folderOf(bot), prompt.includes("You have no tools yet")),
                quotes: QUOTES_SECTION,
                waiting: WAITING_SECTION,
              };
            }),
          newBot: {
            model,
            declare: [],
            instructions: [
              "You are one of the user's bots, running in Top: a daemon that keeps you running 24/7 while the user's desktop and phone apps attach and detach.",
              "Your answers arrive whole, not streamed, often on a phone, so lead with the answer and keep it tight. Use Markdown where it helps.",
            ].join("\n"),
          },
          folder: (bot) => botFolder(home.bots, bot.name),
          firstBots: ["Atlas"],
          files: (bot) => join(botFolder(home.bots, bot.name), FILES_FOLDER),
          skills: skillsOf(home),
          foregroundMs: yield* ForegroundMs,
          retryDelaysMs: yield* RetryDelaysMs,
          compactAtTokens: yield* CompactAtTokens,
          webSearch: canSearchTheWeb(found),
          harnesses: [
            claudeAdapter(),
            codexAdapter({ clientVersion: BUILD.version }),
            t3codeAdapter({ file: home.t3code }),
            codexCloudAdapter(),
            claudeCloudAdapter(),
          ],
          maxTasks: maxTasks(),
        });
      }),
    );
    return Layer.merge(kit, ChatGPT.layer({ models, model, hostPath: home.chatgptHost, fs }));
  });

const fakeBots = (args: Args, home: Home.Layout) =>
  Layer.effect(
    Daemon.BotKit,
    Effect.gen(function* () {
      const store = yield* Store.Store;
      const model = `${FAKE_PROVIDER}/${FAKE_MODEL}`;
      const models = createModels();
      models.setProvider((yield* makeFakeModelProvider(args.tps)).provider);
      const filesOf = (bot: Pick<Store.BotRow, "name">) => join(botFolder(home.bots, bot.name), FILES_FOLDER);
      const tools = yield* makeFakeTools(join(home.server, "effects.jsonl"), (id) => Effect.map(store.bot(id), (bot) => bot && filesOf(bot)));
      return Daemon.BotKit.of({
        models,
        tools,
        thinking: "off",
        newBot: { model, instructions: Daemon.DEFAULT_INSTRUCTIONS, declare: tools },
        folder: (bot) => botFolder(home.bots, bot.name),
        firstBots: BOT_NAMES,
        seed: args.seed,
        files: filesOf,
        skills: skillsOf(home),
        foregroundMs: yield* ForegroundMs,
        retryDelaysMs: yield* RetryDelaysMs,
        compactAtTokens: yield* CompactAtTokens,
        webSearch: true,
        harnesses: [fakeHarness({ stepMs: 1_500 }), t3codeAdapter({ file: home.t3code }), fakeHarness({ stepMs: 1_500, where: "cloud" })],
        maxTasks: maxTasks(),
      });
    }),
  );

const program = (args: Args) =>
  Effect.gen(function* () {
    const real = Option.isSome(args.model);
    if (real && (args.load || args.tools || args.seed > 0))
      return yield* new StartError({ message: "--load, --tools and --seed drive the fake bots; they can't be combined with --model." });
    if (args.tailscalePort < 1 || args.tailscalePort > 65_535)
      return yield* new StartError({ message: `--tailscale-port takes a port number (got "${args.tailscalePort}").` });
    if (!args.tailscale && args.tailscaleAllow.length)
      return yield* new StartError({ message: "--tailscale-allow says who may use Top on your tailnet; add --tailscale to put it there." });

    const home = Home.layout(Option.isSome(args.home) ? resolve(Home.expandTilde(args.home.value)) : real ? yield* Home.defaultHome : resolve(".data/fake"));
    const fs = yield* FileSystem.FileSystem;
    if (args.reset) {
      yield* Effect.orDie(fs.remove(home.server, { recursive: true, force: true }));
      if (!real) yield* Effect.orDie(fs.remove(home.bots, { recursive: true, force: true }));
    }
    yield* Effect.orDie(fs.makeDirectory(home.server, { recursive: true, mode: 0o700 }));
    const kit: Layer.Layer<Daemon.BotKit, Config.ConfigError, FileSystem.FileSystem | Store.Store | Events.Events | Secrets.Secrets> = Option.isSome(args.model)
      ? yield* realBots(args, args.model.value, home)
      : fakeBots(args, home);

    let tailnet: Tailnet | undefined;
    if (args.tailscale) {
      tailnet = yield* connectTailnet({ allow: args.tailscaleAllow, port: args.tailscalePort, cli: yield* systemCli }).pipe(
        Effect.mapError((error) => new StartError({ message: error.message })),
      );
    }

    const oauthPort = args.port + 1;
    const storeLayer = Store.layer.pipe(Layer.provide(Sqlite.layer({ filename: home.database })));
    const installed = BUILD.channel && process.env.TOP_DAEMON_DIR ? installLayout(home.home) : undefined;
    const releasesUrl = process.env.TOP_RELEASES_URL;
    const updatesLayer = installed
      ? Updates.layer({ layout: installed, ...(releasesUrl ? { releasesUrl } : {}) }).pipe(Layer.provide(NodeHttpClient.layerUndici))
      : Layer.empty;
    const daemonLayer = Layer.merge(Daemon.layer, updatesLayer).pipe(
      Layer.provideMerge(kit),
      Layer.provideMerge(
        Layer.mergeAll(
          Mcp.layer({ oauthPort, redirectOrigin: tailnet?.origin, clientInfo: { name: "Top", version: BUILD.version } }),
          Attachments.layer(home.server),
          Secrets.layer(home.server),
          T3Link.layer(home.t3code),
        ),
      ),
      Layer.provideMerge(Events.layer),
      Layer.provideMerge(storeLayer),
    );
    const daemonContext = yield* Layer.build(daemonLayer).pipe(Effect.orDie);

    return yield* Effect.gen(function* () {
      const daemon = yield* Daemon.Daemon;
      yield* daemon.start;

      const { tailnetPort } = yield* serve({
        host: args.host,
        port: args.port,
        compress: args.compress,
        allowOrigins: args.allowOrigin,
        ...(tailnet ? { tailnet: { gate: tailnet, port: args.port + 2, oauthPort, oauthPath: Mcp.CALLBACK_PATH } } : {}),
      }).pipe(Effect.mapError((error) => new StartError({ message: error.message })));
      if (tailnet && tailnetPort !== undefined) yield* tailnet.expose(tailnetPort).pipe(Effect.mapError((error) => new StartError({ message: error.message })));
      if (args.load) yield* startLoad({ tools: args.tools });

      const count = daemon.runners().length;
      yield* Effect.log(`${count} bot${count === 1 ? "" : "s"}, home ${home.home}`);
      yield* Effect.log(`listening on ws://${args.host}:${args.port}${args.load ? ` (synthetic load on${args.tools ? ", with tools" : ""})` : ""}`);
      if (tailnet) yield* Effect.log(`on your tailnet at ${tailnet.url}, for ${tailnet.describeAllowed()}`);
      return yield* Effect.never;
    }).pipe(Effect.provideContext(daemonContext));
  }).pipe(
    Effect.scoped,
    Effect.catchTag("StartError", (error) =>
      Effect.andThen(
        Effect.logError(error.message),
        Effect.sync(() => process.exit(1)),
      ),
    ),
  );

const homeFlag = lastOptional(Flag.String("home").pipe(Flag.withDescription("Top's home (default $TOP_HOME or ~/.top)")));
const homeOf = (flag: Option.Option<string>) =>
  Effect.map(Option.isSome(flag) ? Effect.succeed(resolve(Home.expandTilde(flag.value))) : Home.defaultHome, Home.layout);

const login = Command.make("login", { home: homeFlag }, ({ home }) => Effect.flatMap(homeOf(home), signInHere)).pipe(
  Command.withDescription("Sign in with ChatGPT, so the bots use your ChatGPT plan."),
);
const logout = Command.make("logout", { home: homeFlag }, ({ home }) => Effect.flatMap(homeOf(home), signOutHere)).pipe(
  Command.withDescription("Forget the ChatGPT sign-in."),
);

const installCommand = Command.make(
  "install",
  {
    home: homeFlag,
    model: lastOptional(Flag.String("model").pipe(Flag.withDescription(`The bots' model (default ${DEFAULT_MODEL})`))),
    tailscale: toggle("tailscale", false),
    tailscaleAllow: Flag.String("tailscale-allow").pipe(Flag.atLeast(0)),
    start: toggle("start", true),
  },
  ({ home, model, tailscale, tailscaleAllow, start }) =>
    Effect.gen(function* () {
      const layout = yield* homeOf(home);
      const given = Option.isSome(model) || tailscale || tailscaleAllow.length > 0;
      const args = given
        ? [
            ...(Option.isSome(model) ? ["--model", model.value] : []),
            ...(tailscale || tailscaleAllow.length ? ["--tailscale"] : []),
            ...tailscaleAllow.flatMap((who) => ["--tailscale-allow", who]),
          ]
        : undefined;
      yield* install({ home: layout.home, args, start }).pipe(
        Effect.catchTag("InstallError", (error) =>
          Effect.andThen(
            Effect.logError(error.message),
            Effect.sync(() => process.exit(1)),
          ),
        ),
      );
    }),
).pipe(Command.withDescription("Install this release of the daemon in Top's home, run it with systemd, and let it update itself."));

const t3Run = (run: () => Promise<void>) =>
  Effect.promise(() =>
    run().then(
      () => process.exit(0),
      (error: unknown) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
      },
    ),
  );
const t3code = Command.make("t3code").pipe(
  Command.withDescription('Connect Top to T3 Code over its API, so bots can hand it coding tasks (harness "t3code").'),
  Command.withSubcommands([
    Command.make("connect", { home: homeFlag, address: Argument.String("address"), plainHttp: toggle("plain-http", false) }, ({ home, address, plainHttp }) =>
      Effect.flatMap(homeOf(home), (layout) => t3Run(() => t3Connect(layout.t3code, address, plainHttp))),
    ).pipe(
      Command.withDescription(
        "Pair with the T3 Code server at this address (https://….ts.net, a tailnet address or http://127.0.0.1:3773), with a pairing code.",
      ),
    ),
    Command.make("status", { home: homeFlag }, ({ home }) => Effect.flatMap(homeOf(home), (layout) => t3Run(() => t3Status(layout.t3code)))).pipe(
      Command.withDescription("Check the connection and list T3 Code's providers, models and projects."),
    ),
    Command.make("disconnect", { home: homeFlag }, ({ home }) => Effect.flatMap(homeOf(home), (layout) => t3Run(() => t3Disconnect(layout.t3code)))).pipe(
      Command.withDescription("Forget the T3 Code connection."),
    ),
  ]),
);

const command = Command.make("top", flags, program).pipe(
  Command.withDescription("The Top daemon: runs your bots and serves the apps."),
  Command.withSubcommands([login, logout, installCommand, t3code]),
);

Command.run(command, { version: BUILD.version }).pipe(
  Effect.provide(Layer.mergeAll(NodeServices.layer, Logger.layer)),
  NodeRuntime.runMain({ disableErrorReporting: false }),
);
