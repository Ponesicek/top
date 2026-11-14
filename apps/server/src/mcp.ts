/**
 * MCP servers, set up once in the app and assigned to bots. A bot has none until it's given one.
 *
 * Each server is one connection, made when the daemon starts (or the server is added) and shared by
 * every bot it's assigned to. It keeps its own secrets and its own OAuth credentials, so the same URL
 * can be added twice to use two accounts. Its tools reach a bot from the bot's next run (see
 * runner.ts), named `<server>__<tool>` so two servers never clash.
 *
 * A server that fails is retried with backoff; one that wants the user to sign in waits for them.
 * Signing in is OAuth with a redirect to a small server on the daemon's computer (127.0.0.1), so the
 * browser has to run there too. With `--tailscale`, the redirect goes to the daemon's tailnet address
 * instead, which passes it to that server (serve.ts), so any device the daemon lets in can finish it.
 *
 * What a daemon restart does to a cut-off MCP call (see tools.ts): a tool the server marks read-only
 * or idempotent runs again; any other is reported as interrupted. A server that isn't connected yet
 * when the daemon settles calls after a restart has its calls reported as interrupted.
 */
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import {
  McpAuthRequiredError,
  McpClient,
  McpHttpError,
  type McpTransport,
  StdioTransport,
  StreamableHttpTransport,
  type Tool,
  toLlmContent,
} from "@earendil-works/pi-mcp";
import {
  adaptOAuthProvider,
  authorizeMcp,
  McpOAuthAuthorizationRequiredError,
  McpOAuthProvider,
  type McpOAuthState,
  OAuthCallbackServer,
} from "@earendil-works/pi-mcp/oauth";
import { check, MAX_MCP_NAME, type McpSecret, McpServerConfig, McpServerError, type McpServerState, type McpServerView } from "@top/protocol";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { COLLAR } from "./collar/names.ts";
import { Events } from "./events.ts";
import { Store } from "./store.ts";
import { ToolError, type ToolResult, type TopTool } from "./tools.ts";

/** Wait before each reconnect of a failed server; the last one repeats. */
const RETRY_DELAYS_MS = [2_000, 10_000, 30_000, 60_000, 300_000];
/** Starting a server can mean `npx` downloading it first. */
const CONNECT_TIMEOUT_MS = 60_000;
/** A tool call may run long; servers that report progress extend it. */
const CALL_TIMEOUT_MS = 10 * 60_000;
const SIGN_IN_TIMEOUT_MS = 10 * 60_000;
export const CALLBACK_PATH = "/mcp/callback";
/** Providers allow tool names of at most 64 characters of [A-Za-z0-9_-]. */
const MAX_TOOL_NAME = 64;

/** `GitHub (work)` → `github_work`: the prefix of the server's tool names. */
export function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** `<server>__<tool>`, cut to what providers accept; a cut name gets a hash so it stays unique. */
export function toolName(server: string, tool: string): string {
  const name = `${slug(server) || "mcp"}__${tool.replace(/[^A-Za-z0-9_-]+/g, "_")}`;
  if (name.length <= MAX_TOOL_NAME) return name;
  const hash = createHash("sha256").update(name).digest("hex").slice(0, 6);
  return `${name.slice(0, MAX_TOOL_NAME - 7)}_${hash}`;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** Why connecting failed, as pi-mcp threw it. */
class ConnectFailure extends Data.TaggedError("ConnectFailure")<{ readonly cause: unknown }> {}

type Connection = {
  readonly id: number;
  name: string;
  /** Secret values included. */
  config: McpServerConfig;
  bots: Set<number>;
  state: McpServerState;
  error: string | undefined;
  tools: Tool[];
  client: McpClient | undefined;
  /** It holds OAuth credentials (an account is signed in). */
  signedIn: boolean;
  /** Counts connection attempts, so a sign-in that ends after a reconnect doesn't report on the new one. */
  attempts: number;
};

export type McpOptions = {
  /** The port of the OAuth redirect (only open while someone signs in). */
  readonly oauthPort: number;
  /** Where the redirect lands instead of `http://127.0.0.1:<oauthPort>`, e.g. the daemon's tailnet address. */
  readonly redirectOrigin?: string | undefined;
  readonly clientInfo?: { readonly name: string; readonly version: string } | undefined;
};

export class Mcp extends Context.Service<
  Mcp,
  {
    readonly views: Effect.Effect<McpServerView[]>;
    /**
     * Add a server (no `id`) or change one, then (re)connect it. Fails with an `McpServerError` the user
     * can read when something's missing or wrong. A secret sent without a value keeps the stored one.
     */
    readonly save: (id: number | undefined, name: string, config: McpServerConfig) => Effect.Effect<number, McpServerError>;
    readonly delete: (id: number) => Effect.Effect<void, McpServerError>;
    /** Give a bot a server's tools, or take them away. They change from the bot's next run. */
    readonly assign: (id: number, bot: number, on: boolean) => Effect.Effect<void, McpServerError>;
    /** A bot was deleted (the store already dropped its assignments). */
    readonly botRemoved: (bot: number) => Effect.Effect<void>;
    readonly retry: (id: number) => Effect.Effect<void, McpServerError>;
    /** Forget the server's OAuth credentials and reconnect, which asks for a new sign-in. */
    readonly signOut: (id: number) => Effect.Effect<void, McpServerError>;
    /**
     * Start signing in: answers with the page to open in a browser. When the browser comes back with
     * the grant, the server reconnects with it.
     */
    readonly signIn: (id: number) => Effect.Effect<string, McpServerError>;
    /** The tools a bot gets from its connected servers, as they are now. */
    readonly toolsFor: (bot: number) => TopTool[];
  }
>()("top/Mcp") {}

/** The MCP servers set up in the app, each connected (and kept connected) while the layer lives. */
export const layer = (options: McpOptions): Layer.Layer<Mcp, never, Store | Events> =>
  Layer.effect(
    Mcp,
    Effect.gen(function* () {
      const store = yield* Store;
      const events = yield* Events;
      const runPromise = Effect.runPromiseWith(yield* Effect.context<Store | Events>());
      const runFork = Effect.runForkWith(yield* Effect.context<Store | Events>());
      const scope = yield* Effect.scope;
      const servers = new Map<number, Connection>();
      const fibers = yield* FiberMap.make<number>();
      const redirectUrl = `${options.redirectOrigin ?? `http://127.0.0.1:${options.oauthPort}`}${CALLBACK_PATH}`;
      /** OAuth `state`s whose redirect the callback server is waiting for. */
      const waiting = new Set<string>();
      let callback: Promise<OAuthCallbackServer> | undefined;

      const view = (connection: Connection): McpServerView => {
        const config = connection.config;
        const hide = (list: readonly McpSecret[]) => list.map((s) => ({ name: s.name }));
        return {
          id: connection.id,
          name: connection.name,
          config: config.transport === "stdio" ? { ...config, env: hide(config.env) } : { ...config, headers: hide(config.headers) },
          bots: [...connection.bots].sort((a, b) => a - b),
          state: connection.state,
          ...(connection.error ? { error: connection.error } : {}),
          tools: connection.tools.map((t) => t.name),
          ...(connection.signedIn ? { signedIn: true as const } : {}),
        };
      };

      const changed = (connection: Connection) =>
        Effect.suspend(() => (servers.get(connection.id) === connection ? events.publish({ _tag: "McpServer", view: view(connection) }) : Effect.void));

      const get = (id: number) =>
        Effect.suspend(() => {
          const connection = servers.get(id);
          return connection ? Effect.succeed(connection) : Effect.fail(new McpServerError({ message: "That MCP server was removed." }));
        });

      /** OAuth for one server, its credentials kept in the store (so each connection is its own account). */
      const oauthProvider = (connection: Connection, onRedirect: (url: URL) => void): McpOAuthProvider => {
        const config = connection.config;
        if (config.transport !== "http") throw new Error("OAuth needs an HTTP server");
        const { id } = connection;
        return new McpOAuthProvider({
          serverUrl: config.url,
          redirectUrl,
          clientMetadata: { client_name: "Top", redirect_uris: [redirectUrl] },
          store: {
            load: () => runPromise(Effect.map(store.mcpServer(id), (row) => (row?.oauth ? (JSON.parse(row.oauth) as McpOAuthState) : undefined))),
            save: (state) =>
              runPromise(
                Effect.gen(function* () {
                  if (!(yield* store.mcpServer(id))) return;
                  yield* store.setMcpOAuth(id, JSON.stringify(state));
                  const signedIn = state.tokens !== undefined;
                  if (signedIn === connection.signedIn) return;
                  connection.signedIn = signedIn;
                  yield* changed(connection);
                }),
              ),
          },
          onRedirect,
        });
      };

      const transport = (connection: Connection): McpTransport => {
        const config = connection.config;
        if (config.transport === "stdio") {
          return new StdioTransport({
            command: config.command,
            args: config.args,
            // The daemon's own environment (PATH, HOME…) plus the server's variables.
            env: Object.fromEntries(config.env.map((v) => [v.name, v.value ?? ""])),
            inheritEnv: true,
            cwd: homedir(),
            stderr: "pipe",
            maxStderrBytes: 16_384,
          });
        }
        const headers = Object.fromEntries(config.headers.map((h) => [h.name, h.value ?? ""]));
        return new StreamableHttpTransport({
          url: config.url,
          headers,
          // With an Authorization header of its own the server needs no OAuth.
          ...(hasAuthorization(config) ? {} : { authProvider: adaptOAuthProvider(oauthProvider(connection, () => {})) }),
        });
      };

      type Attempt =
        | { readonly done: "signin" }
        | { readonly done: "refused" }
        /** `connected`: it was ready before it failed (the connection closed). */
        | { readonly done: "failed"; readonly error: string; readonly connected?: true };

      /** One connection: ready until it closes (then failed), or why it couldn't connect. */
      const connectOnce = (connection: Connection): Effect.Effect<Attempt> =>
        Effect.scoped(
          Effect.gen(function* () {
            connection.attempts++;
            const client = yield* Effect.acquireRelease(
              Effect.sync(() => new McpClient({ ...(options.clientInfo ?? { name: "top", version: "0.0.0" }), requestTimeoutMs: CONNECT_TIMEOUT_MS })),
              (client) =>
                Effect.promise(() => client.close().catch(() => {})).pipe(
                  Effect.andThen(
                    Effect.sync(() => {
                      if (connection.client === client) connection.client = undefined;
                    }),
                  ),
                ),
            );
            let used: McpTransport | undefined;
            const connected = yield* Effect.tryPromise({
              try: async () => {
                used = transport(connection);
                await client.connect(used);
                return await client.listTools();
              },
              catch: (cause) => new ConnectFailure({ cause }),
            }).pipe(Effect.result);
            if (connected._tag === "Failure") {
              const error = connected.failure.cause;
              if (error instanceof McpOAuthAuthorizationRequiredError) return { done: "signin" } as const;
              if (error instanceof McpAuthRequiredError) return { done: "refused" } as const;
              const stderr = used instanceof StdioTransport ? lastLines(used.stderr) : "";
              return { done: "failed", error: messageOf(error) + (stderr ? `\n${stderr}` : "") } as const;
            }
            connection.client = client;
            connection.tools = connected.success;
            connection.state = "ready";
            connection.error = undefined;
            yield* changed(connection);
            const closed = yield* Deferred.make<void>();
            client.onNotification("notifications/tools/list_changed", () => {
              runFork(
                Effect.tryPromise(() => client.listTools()).pipe(
                  Effect.flatMap((next) =>
                    Effect.suspend(() => {
                      if (connection.client !== client) return Effect.void;
                      connection.tools = next;
                      return changed(connection);
                    }),
                  ),
                  Effect.ignore,
                ),
              );
            });
            client.onClose(() => Deferred.doneUnsafe(closed, Effect.void));
            yield* Deferred.await(closed);
            return { done: "failed", error: "The connection closed.", connected: true } as const;
          }),
        );

      /** Keep a server connected: retry with backoff, wait for a sign-in, or give up on refused credentials. */
      const keepConnected = (connection: Connection) =>
        Effect.gen(function* () {
          let failures = 0;
          for (;;) {
            connection.client = undefined;
            connection.tools = [];
            connection.state = "connecting";
            connection.error = undefined;
            yield* changed(connection);
            const result = yield* connectOnce(connection);
            connection.tools = [];
            if (result.done === "signin") {
              connection.state = "signin";
              connection.error = undefined;
              return yield* changed(connection);
            }
            connection.state = "failed";
            // Only with an Authorization header of the user's (otherwise OAuth handles a 401): it was refused.
            connection.error = result.done === "refused" ? "The server refused the credentials (HTTP 401). Check the Authorization header." : result.error;
            yield* changed(connection);
            if (result.done === "refused") return;
            // A connection that worked starts the backoff over: a server that drops now and then isn't failing.
            if (result.done === "failed" && result.connected) failures = 0;
            yield* Effect.sleep(Duration.millis(RETRY_DELAYS_MS[Math.min(failures, RETRY_DELAYS_MS.length - 1)]!));
            failures++;
          }
        });

      /** (Re)connect: a connection already running is interrupted, which closes its client. */
      const connect = (connection: Connection) => Effect.asVoid(FiberMap.run(fibers, connection.id, keepConnected(connection)));

      const callbackServer = Effect.suspend(() => {
        callback ??= OAuthCallbackServer.listen({
          host: "127.0.0.1",
          port: options.oauthPort,
          path: CALLBACK_PATH,
          timeoutMs: SIGN_IN_TIMEOUT_MS,
          renderPage: (page) =>
            `<!doctype html><meta charset="utf-8"><title>Top</title><body style="font:15px system-ui;margin:3em;max-width:36em">` +
            (page.ok ? "<h2>Signed in</h2><p>You can close this tab and go back to Top.</p>" : `<h2>Couldn't sign in</h2><p>${escapeHtml(page.message)}</p>`),
        });
        const opening = callback;
        return Effect.tryPromise({
          try: () => opening,
          catch: (error) => {
            if (callback === opening) callback = undefined;
            return new McpServerError({ message: `Couldn't open the sign-in redirect on port ${options.oauthPort}: ${messageOf(error)}` });
          },
        });
      });
      const closeCallbackServer = Effect.suspend(() => {
        const closing = callback;
        callback = undefined;
        return closing ? Effect.promise(() => closing.then((server) => server.close()).catch(() => {})) : Effect.void;
      });
      yield* Effect.addFinalizer(() => closeCallbackServer);

      /** Check a config from a client (its shape is checked already) and fill in the secrets it left out from `previous`. */
      const validate = (config: McpServerConfig, previous: McpServerConfig | undefined) =>
        Effect.gen(function* () {
          if (config.transport === "stdio") {
            const command = config.command.trim();
            if (!command) return yield* refuse("Give the command that starts the server.");
            const args = [...config.args];
            const env = yield* secrets(config.env, previous?.transport === "stdio" ? previous.env : [], false, "variable");
            for (const v of env) if (!ENV_NAME.test(v.name)) return yield* refuse(`"${v.name}" isn't a valid environment variable name.`);
            return { transport: "stdio", command, args, env } satisfies McpServerConfig;
          }
          const parsed = parseUrl(config.url.trim());
          if (!parsed) return yield* refuse("Give the server's full URL, starting with https://.");
          if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return yield* refuse("The URL has to start with https:// or http://.");
          const headers = yield* secrets(config.headers, previous?.transport === "http" ? previous.headers : [], true, "header");
          for (const h of headers) if (!HEADER_NAME.test(h.name)) return yield* refuse(`"${h.name}" isn't a valid header name.`);
          return { transport: "http", url: parsed.href, headers } satisfies McpServerConfig;
        });

      const adapt = (connection: Connection, tool: Tool): TopTool => {
        const { id, name: server } = connection;
        const hints = tool.annotations ?? {};
        const description = tool.description?.trim() || tool.title || tool.name;
        return {
          name: toolName(server, tool.name),
          label: `${tool.title ?? hints.title ?? tool.name} (${server})`,
          // The server's name tells two accounts of one service apart.
          description: `From the MCP server "${server}".\n\n${description}`,
          // Providers want an object schema, and some reject one without `properties`.
          parameters: { ...tool.inputSchema, type: "object", properties: tool.inputSchema.properties ?? {} },
          replay: hints.readOnlyHint === true || hints.idempotentHint === true ? "safe" : "never",
          run: (args, ctx) =>
            Effect.suspend(() => {
              // Looked up per call: the server may have reconnected (a new client) or been removed since.
              const current = servers.get(id);
              const client = current?.client;
              if (!client || current.state !== "ready")
                return Effect.fail(new ToolError({ message: `The MCP server "${server}" isn't connected${current?.error ? `: ${current.error}` : ""}.` }));
              return Effect.tryPromise({
                try: () => client.callTool(tool.name, args, { ...(ctx.signal ? { signal: ctx.signal } : {}), timeoutMs: CALL_TIMEOUT_MS }),
                catch: ToolError.from,
              }).pipe(Effect.map((result): ToolResult => ({ content: toLlmContent(result), details: {}, isError: result.isError === true }) as ToolResult));
            }),
        };
      };

      // The servers set up so far, connected in the background: a slow one mustn't hold up the bots.
      const assignments = yield* store.mcpAssignments;
      for (const row of yield* store.mcpServers) {
        const oauth = row.oauth ? (JSON.parse(row.oauth) as McpOAuthState) : undefined;
        const connection: Connection = {
          id: row.id,
          name: row.name,
          config: check(McpServerConfig, JSON.parse(row.config), `saved settings of MCP server ${row.name}`),
          bots: new Set(assignments.get(row.id) ?? []),
          state: "connecting",
          error: undefined,
          tools: [],
          client: undefined,
          signedIn: oauth?.tokens !== undefined,
          attempts: 0,
        };
        servers.set(row.id, connection);
        yield* connect(connection);
      }

      return Mcp.of({
        views: Effect.sync(() => [...servers.values()].map(view)),
        save: Effect.fn("Mcp.save")(function* (id, rawName, config) {
          const existing = id === undefined ? undefined : yield* get(id);
          const name = rawName.trim().replace(/\s+/g, " ");
          if (!name) return yield* refuse("Give the server a name.");
          if (name.length > MAX_MCP_NAME) return yield* refuse(`Keep the name under ${MAX_MCP_NAME + 1} characters.`);
          if (!slug(name)) return yield* refuse("Use some letters or digits in the name.");
          // Its tools would clash with Top's own (collar/index.ts).
          if (slug(name) === COLLAR) return yield* refuse(`${name} is the name of Top's own tools. Pick another.`);
          for (const other of servers.values()) {
            if (other.id === id) continue;
            if (other.name.toLowerCase() === name.toLowerCase()) return yield* refuse(`There's already a server named ${other.name}.`);
            // Their tools would get the same names.
            if (slug(other.name) === slug(name))
              return yield* refuse(`That name is too close to ${other.name}. Pick one that differs in more than punctuation.`);
          }
          const clean = yield* validate(config, existing?.config);
          if (existing) {
            // Credentials belong to one server: a new URL (or a switch to a program) signs in again.
            const resetOAuth = existing.config.transport !== "http" || clean.transport !== "http" || existing.config.url !== clean.url;
            yield* store.updateMcpServer(existing.id, name, JSON.stringify(clean), resetOAuth);
            existing.name = name;
            existing.config = clean;
            if (resetOAuth) existing.signedIn = false;
            yield* connect(existing);
            return existing.id;
          }
          const newId = yield* store.createMcpServer(name, JSON.stringify(clean));
          const connection: Connection = {
            id: newId,
            name,
            config: clean,
            bots: new Set(),
            state: "connecting",
            error: undefined,
            tools: [],
            client: undefined,
            signedIn: false,
            attempts: 0,
          };
          servers.set(newId, connection);
          yield* connect(connection);
          return newId;
        }),
        delete: Effect.fn("Mcp.delete")(function* (id) {
          yield* get(id);
          servers.delete(id);
          yield* store.deleteMcpServer(id);
          yield* FiberMap.remove(fibers, id);
          yield* events.publish({ _tag: "McpServerRemoved", id });
        }),
        assign: Effect.fn("Mcp.assign")(function* (id, bot, on) {
          const connection = yield* get(id);
          if (connection.bots.has(bot) === on) return;
          yield* store.assignMcp(id, bot, on);
          if (on) connection.bots.add(bot);
          else connection.bots.delete(bot);
          yield* changed(connection);
        }),
        botRemoved: (bot) =>
          Effect.forEach(servers.values(), (connection) => (connection.bots.delete(bot) ? changed(connection) : Effect.void), { discard: true }),
        retry: Effect.fn("Mcp.retry")((id: number) => Effect.flatMap(get(id), connect)),
        signOut: Effect.fn("Mcp.signOut")(function* (id) {
          const connection = yield* get(id);
          yield* store.setMcpOAuth(id, null);
          connection.signedIn = false;
          yield* connect(connection);
        }),
        signIn: Effect.fn("Mcp.signIn")(function* (id) {
          const connection = yield* get(id);
          const config = connection.config;
          if (config.transport !== "http") return yield* new McpServerError({ message: `${connection.name} runs as a program; it has no sign-in.` });
          if (hasAuthorization(config))
            return yield* new McpServerError({
              message: `${connection.name} signs in with its Authorization header. Remove the header to sign in with OAuth instead.`,
            });
          let authorizationUrl: string | undefined;
          const provider = oauthProvider(connection, (url) => {
            authorizationUrl = url.href;
          });
          // Registered for another redirect (the daemon's port changed): register again.
          const client = yield* Effect.promise(() => provider.clientInformation());
          if (client && "redirect_uris" in client && Array.isArray(client.redirect_uris) && !client.redirect_uris.includes(redirectUrl)) {
            yield* Effect.promise(() => provider.invalidateCredentials("client"));
          }
          const server = yield* callbackServer;
          const result = yield* Effect.tryPromise({
            try: () => authorizeMcp(provider, { serverUrl: config.url, skipRefresh: true }),
            catch: (error) => new McpServerError({ message: `Couldn't start signing in to ${connection.name}: ${messageOf(error)}` }),
          });
          if (result === "AUTHORIZED" || !authorizationUrl) {
            yield* connect(connection);
            return yield* new McpServerError({ message: `${connection.name} is already signed in.` });
          }
          const state = yield* Effect.promise(() => provider.state());
          if (!waiting.has(state)) {
            waiting.add(state);
            const attempts = connection.attempts;
            const finish = Effect.tryPromise(async () => {
              const { code, iss } = await server.waitForCallback(state);
              await authorizeMcp(provider, { serverUrl: config.url, authorizationCode: code, ...(iss ? { iss } : {}) });
            }).pipe(
              Effect.andThen(Effect.suspend(() => (servers.get(id) === connection ? connect(connection) : Effect.void))),
              Effect.catchCause((cause) =>
                Effect.suspend(() => {
                  if (servers.get(id) !== connection || connection.attempts !== attempts) return Effect.void;
                  connection.error = `Signing in didn't finish: ${messageOf(Cause.squash(cause))}`;
                  return changed(connection);
                }),
              ),
              Effect.ensuring(
                Effect.suspend(() => {
                  waiting.delete(state);
                  return waiting.size === 0 ? closeCallbackServer : Effect.void;
                }),
              ),
            );
            yield* Effect.forkIn(finish, scope);
          }
          return authorizationUrl;
        }),
        toolsFor: (bot) => {
          const tools: TopTool[] = [];
          for (const connection of servers.values()) {
            if (!connection.bots.has(bot) || connection.state !== "ready") continue;
            for (const tool of connection.tools) tools.push(adapt(connection, tool));
          }
          return tools;
        },
      });
    }),
  );

/** A refusal the user reads. */
const refuse = (message: string) => new McpServerError({ message });

/** A URL, or undefined if it isn't one. */
function parseUrl(text: string): URL | undefined {
  try {
    return new URL(text);
  } catch {
    return undefined;
  }
}

/**
 * The secrets a client sent, with stored values for those it sent without one. A name may appear once
 * (headers ignore case).
 */
const secrets = (sent: readonly McpSecret[], stored: readonly McpSecret[], ignoreCase: boolean, what: string) =>
  Effect.gen(function* () {
    const key = (name: string) => (ignoreCase ? name.toLowerCase() : name);
    const before = new Map(stored.map((s) => [key(s.name), s.value]));
    const seen = new Set<string>();
    const result: McpSecret[] = [];
    for (const secret of sent) {
      const name = secret.name.trim();
      if (!name) continue;
      if (seen.has(key(name))) return yield* refuse(`The ${what} ${name} is there twice.`);
      seen.add(key(name));
      const value = secret.value ?? before.get(key(name));
      if (value === undefined) return yield* refuse(`Give the ${what} ${name} a value.`);
      result.push({ name, value });
    }
    return result;
  });

const hasAuthorization = (config: Extract<McpServerConfig, { transport: "http" }>) => config.headers.some((h) => h.name.toLowerCase() === "authorization");

function messageOf(error: unknown): string {
  if (error instanceof McpHttpError) return `HTTP ${error.status}${error.message ? `: ${error.message}` : ""}`;
  if (error instanceof Error) return error.message;
  return String(error);
}

/** The end of a server's stderr, which usually says why it didn't start. */
function lastLines(text: string, lines = 6): string {
  return text.trim().split(/\r?\n/).slice(-lines).join("\n").slice(-800);
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
