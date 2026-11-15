/**
 * The Top daemon: runs the bots 24/7 on its own agent loop with its own SQLite storage, and serves any
 * number of desktop and phone clients over one WebSocket each.
 *
 *   node --import tsx src/main.ts --model openai/gpt-6.1-sol [--thinking medium]   real bots
 *   node --import tsx src/main.ts [--load] [--tools] [--seed N] [--tps 100]          fake bots
 *   node --import tsx src/main.ts login | logout [--home DIR]                       Sign in with ChatGPT
 *   common: [--port 7357] [--host 127.0.0.1] [--home DIR] [--reset] [--no-compress]
 *           [--tailscale [--tailscale-allow LOGIN|tag:TAG|DEVICE]... [--tailscale-port 7357]]
 *
 * Everything the daemon keeps is in its home, `~/.top` (`$TOP_HOME`, or `--home`; see home.ts). With
 * `--model`, the bots run on that model, signed in with ChatGPT (from the app, or `top login`; see
 * chatgpt.ts) or with an API key in the environment. Each works in its own folder, `~/.top/bots/<name>`, with
 * full access to the computer (see workspace.ts). Without it they run on a scripted fake model with
 * fake tools, for development, tests and benchmarks, in a home of their own (`.data/fake`).
 *
 * With `--tailscale`, the daemon is also at `wss://<device>.<tailnet>.ts.net:7357`, through the
 * computer's own Tailscale, for every device on the tailnet, or only whoever `--tailscale-allow` names
 * (see tailscale.ts).
 *
 * Everything the daemon opens is a scoped resource: on SIGINT or SIGTERM they close in reverse order
 * (load, Tailscale Serve, the listeners, the bots, MCP servers, the database).
 */
import { join, resolve } from "node:path";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { DEFAULT_PORT } from "@top/protocol";
import type * as Config from "effect/Config";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Attachments from "./attachments.ts";
import { AuthFile } from "./auth.ts";
import * as ChatGPT from "./chatgpt.ts";
import * as Daemon from "./daemon.ts";
import * as Events from "./events.ts";
import { BOT_NAMES, FAKE_MODEL, FAKE_PROVIDER, makeFakeModelProvider } from "./fake-bots.ts";
import * as Home from "./home.ts";
import { ForegroundMs } from "./jobs.ts";
import { startLoad } from "./load.ts";
import * as Logger from "./logger.ts";
import { signInHere, signOutHere } from "./login.ts";
import type { ThinkingLevel } from "./loop.ts";
import * as Mcp from "./mcp.ts";
import { RetryDelaysMs } from "./runner.ts";
import { serve } from "./serve.ts";
import * as Sqlite from "./sqlite.ts";
import * as Store from "./store.ts";
import { connectTailnet, systemCli, TAILNET_PORT, type Tailnet } from "./tailscale.ts";
import { makeFakeTools } from "./tools.ts";
import { botFolder, computerTools, ensureFolder, FILES_FOLDER, workspaceSection } from "./workspace.ts";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly ThinkingLevel[];

/** The daemon can't start as asked: `message` says why, for the user. */
class StartError extends Data.TaggedError("StartError")<{ readonly message: string }> {}

/** How the user's quotes of earlier answers reach a bot (the desktop app's quotes.ts makes them). */
const QUOTES_SECTION = [
  "<quotes>",
  "The user can quote passages of your earlier answers. A quote appears in their message as a link: [Quote](top-quote://v1/<seq>?text=<passage>&comment=<comment>), URL-encoded (+ is a space).",
  "`text` is the passage they quoted from your answer, `seq` that answer's entry number, and `comment`, when present, what they say about that passage specifically. The text around the links is the rest of their message; where they put each quote in it matters.",
  "</quotes>",
].join("\n");

/** Given more than once, the last one counts (as `node:util`'s parseArgs had it, and scripts rely on). */
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
  /** `--no-compress` turns it off. */
  compress: toggle("compress", true),
  tailscale: toggle("tailscale", false),
  tailscaleAllow: Flag.String("tailscale-allow").pipe(Flag.atLeast(0)),
  tailscalePort: last(Flag.Int("tailscale-port"), TAILNET_PORT),
};

type Args = Command.Command.Config.Infer<typeof flags>;

/** What real bots are made of: a signed-in model, and the computer's tools in their own folders. */
const realBots = (args: Args, model: string, home: Home.Layout) =>
  Effect.gen(function* () {
    const slash = model.indexOf("/");
    if (slash <= 0) return yield* new StartError({ message: `--model takes provider/model-id, e.g. openai/gpt-6.1-sol (got "${model}").` });
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
    // Signed out, the daemon still starts: the user signs in from the app (or with `top login`).
    if (!auth) yield* Effect.logWarning("Not signed in: sign in with ChatGPT in the app's Settings, or run `top login`. The bots can't answer until then.");
    if (!models.getModel(providerId, model.slice(slash + 1))) {
      yield* Effect.promise(() => models.refresh({ providers: [providerId] }).catch(() => undefined));
      if (!models.getModel(providerId, model.slice(slash + 1)))
        return yield* new StartError({ message: `${providerId} has no model "${model.slice(slash + 1)}".` });
    }
    yield* Effect.log(`model ${model} (${auth ? (auth.source ?? auth.type) : "not signed in"}), thinking ${args.thinking}`);
    const kit = Layer.effect(
      Daemon.BotKit,
      Effect.gen(function* () {
        const store = yield* Store.Store;
        // Each bot works in a folder it owns, with pi's tools over the whole computer. The tools are
        // declared to the model on its next request, and the workspace section with its next message.
        const folderOf = (bot: Store.BotRow) => ensureFolder(botFolder(home.bots, bot.name)).pipe(Effect.provideService(FileSystem.FileSystem, fs));
        return Daemon.BotKit.of({
          models,
          tools: (bot) => Effect.map(folderOf(bot), computerTools),
          thinking: args.thinking,
          sections: (bot) =>
            Effect.gen(function* () {
              const prompt = getCurrentSystemPrompt(yield* store.context(bot.id));
              return { workspace: workspaceSection(yield* folderOf(bot), prompt.includes("You have no tools yet")), quotes: QUOTES_SECTION };
            }),
          // Real bots' tools are declared on their first request, so their first system message holds only instructions.
          newBot: {
            model,
            declare: [],
            instructions: (name, description) =>
              [
                `You are ${name}, one of the user's bots, running in Top: a daemon that keeps you running 24/7 while the user's desktop and phone apps attach and detach.`,
                ...(description ? [Daemon.purpose(description)] : []),
                "Your answers arrive whole, not streamed, often on a phone, so lead with the answer and keep it tight. Use Markdown where it helps.",
              ].join("\n"),
          },
          // One bot to start with; the app makes more.
          firstBots: ["Atlas"],
          files: (bot) => join(botFolder(home.bots, bot.name), FILES_FOLDER),
          foregroundMs: yield* ForegroundMs,
          retryDelaysMs: yield* RetryDelaysMs,
        });
      }),
    );
    return Layer.merge(kit, ChatGPT.layer({ models, model, hostPath: home.chatgptHost, fs }));
  });

/** What fake bots are made of: a scripted model and tools with real (recorded) side effects. */
const fakeBots = (args: Args, home: Home.Layout) =>
  Layer.effect(
    Daemon.BotKit,
    Effect.gen(function* () {
      const store = yield* Store.Store;
      const model = `${FAKE_PROVIDER}/${FAKE_MODEL}`;
      const models = createModels();
      models.setProvider((yield* makeFakeModelProvider(args.tps)).provider);
      const filesOf = (bot: Store.BotRow) => join(botFolder(home.bots, bot.name), FILES_FOLDER);
      const tools = yield* makeFakeTools(join(home.server, "effects.jsonl"), (id) => Effect.map(store.bot(id), (bot) => bot && filesOf(bot)));
      return Daemon.BotKit.of({
        models,
        tools,
        thinking: "off",
        newBot: { model, instructions: Daemon.defaultInstructions, declare: tools },
        firstBots: BOT_NAMES,
        seed: args.seed,
        files: filesOf,
        foregroundMs: yield* ForegroundMs,
        retryDelaysMs: yield* RetryDelaysMs,
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

    // Real and fake bots have separate homes, so trying the fake ones never touches real transcripts.
    const home = Home.layout(Option.isSome(args.home) ? resolve(Home.expandTilde(args.home.value)) : real ? yield* Home.defaultHome : resolve(".data/fake"));
    const fs = yield* FileSystem.FileSystem;
    // A reset starts the daemon over. Real bots' folders are the user's work, so it leaves them; fake ones go too.
    if (args.reset) {
      yield* Effect.orDie(fs.remove(home.server, { recursive: true, force: true }));
      if (!real) yield* Effect.orDie(fs.remove(home.bots, { recursive: true, force: true }));
    }
    yield* Effect.orDie(fs.makeDirectory(home.server, { recursive: true, mode: 0o700 }));
    // Real bots' layer also has the ChatGPT sign-in (serve.ts looks for it); the daemon needs only the kit.
    const kit: Layer.Layer<Daemon.BotKit, Config.ConfigError, FileSystem.FileSystem | Store.Store | Events.Events> = Option.isSome(args.model)
      ? yield* realBots(args, args.model.value, home)
      : fakeBots(args, home);

    // On the tailnet: who may connect is settled before anything listens.
    let tailnet: Tailnet | undefined;
    if (args.tailscale) {
      tailnet = yield* connectTailnet({ allow: args.tailscaleAllow, port: args.tailscalePort, cli: yield* systemCli }).pipe(
        Effect.mapError((error) => new StartError({ message: error.message })),
      );
    }

    // MCP servers set up in the app. Signing in to one redirects to the port after the daemon's (or, on
    // the tailnet, to the daemon's tailnet address, which passes it on).
    const oauthPort = args.port + 1;
    const storeLayer = Store.layer.pipe(Layer.provide(Sqlite.layer({ filename: home.database })));
    const daemonLayer = Daemon.layer.pipe(
      Layer.provideMerge(kit),
      Layer.provideMerge(
        Layer.mergeAll(
          Mcp.layer({ oauthPort, redirectOrigin: tailnet?.origin, clientInfo: { name: "Top", version: "0.0.0" } }),
          Attachments.layer(home.server),
        ),
      ),
      Layer.provideMerge(Events.layer),
      Layer.provideMerge(storeLayer),
    );
    const daemonContext = yield* Layer.build(daemonLayer).pipe(Effect.orDie);

    return yield* Effect.gen(function* () {
      const daemon = yield* Daemon.Daemon;
      // Settle what the last process left unfinished (interrupted tool calls, half-done tasks), then run.
      yield* daemon.start;

      // The tailnet listener: 127.0.0.1 only, two after the daemon's port (the one after is the sign-in redirect).
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

const command = Command.make("top", flags, program).pipe(
  Command.withDescription("The Top daemon: runs your bots and serves the apps."),
  Command.withSubcommands([login, logout]),
);

Command.run(command, { version: "0.0.0" }).pipe(
  Effect.provide(Layer.mergeAll(NodeServices.layer, Logger.layer)),
  // A second Ctrl-C while shutting down exits at once.
  NodeRuntime.runMain({ disableErrorReporting: false }),
);
