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
 * browser has to run there too.
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
  StdioTransport,
  StreamableHttpTransport,
  toLlmContent,
  type McpTransport,
  type Tool,
} from "@earendil-works/pi-mcp";
import {
  adaptOAuthProvider,
  authorizeMcp,
  McpOAuthAuthorizationRequiredError,
  McpOAuthProvider,
  OAuthCallbackServer,
  type McpOAuthState,
} from "@earendil-works/pi-mcp/oauth";
import { MAX_MCP_NAME, type McpSecret, type McpServerConfig, type McpServerState, type McpServerView } from "@top/protocol";
import { COLLAR } from "./collar/index.ts";
import type { McpServerRow, Store } from "./store.ts";
import type { ToolResult, TopTool } from "./tools.ts";

/** Wait before each reconnect of a failed server; the last one repeats. */
const RETRY_DELAYS_MS = [2_000, 10_000, 30_000, 60_000, 300_000];
/** Starting a server can mean `npx` downloading it first. */
const CONNECT_TIMEOUT_MS = 60_000;
/** A tool call may run long; servers that report progress extend it. */
const CALL_TIMEOUT_MS = 10 * 60_000;
const SIGN_IN_TIMEOUT_MS = 10 * 60_000;
const CALLBACK_PATH = "/mcp/callback";
/** Providers allow tool names of at most 64 characters of [A-Za-z0-9_-]. */
const MAX_TOOL_NAME = 64;

/** A server was refused (empty or taken name, bad URL): the message is meant for the user. */
export class McpServerError extends Error {
  override name = "McpServerError";
}

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
  /** Bumped by every (re)connect and by removal; a connection attempt that isn't the newest gives up. */
  generation: number;
  failures: number;
  retryTimer: ReturnType<typeof setTimeout> | undefined;
};

export type McpManagerOptions = {
  /** The port of the OAuth redirect (only open while someone signs in). */
  readonly oauthPort: number;
  readonly clientInfo?: { readonly name: string; readonly version: string };
};

export class McpManager {
  readonly #store: Store;
  readonly #options: McpManagerOptions;
  readonly #servers = new Map<number, Connection>();
  readonly #changeListeners = new Set<(view: McpServerView) => void>();
  readonly #removedListeners = new Set<(id: number) => void>();
  #callback: Promise<OAuthCallbackServer> | undefined;
  /** OAuth `state`s whose redirect the callback server is waiting for. */
  readonly #waiting = new Set<string>();
  #closed = false;

  constructor(store: Store, options: McpManagerOptions) {
    this.#store = store;
    this.#options = options;
    const assignments = store.mcpAssignments();
    for (const row of store.mcpServers()) {
      this.#servers.set(row.id, {
        id: row.id,
        name: row.name,
        config: JSON.parse(row.config) as McpServerConfig,
        bots: new Set(assignments.get(row.id) ?? []),
        state: "connecting",
        error: undefined,
        tools: [],
        client: undefined,
        generation: 0,
        failures: 0,
        retryTimer: undefined,
      });
    }
  }

  get #redirectUrl() {
    return `http://127.0.0.1:${this.#options.oauthPort}${CALLBACK_PATH}`;
  }

  /** Connect to every server. Doesn't wait: a slow server mustn't hold up the bots. */
  start() {
    for (const connection of this.#servers.values()) void this.#connect(connection);
  }

  /** Disconnect everything (stops the servers' programs). */
  async close() {
    this.#closed = true;
    const closing = [...this.#servers.values()].map((connection) => this.#disconnect(connection));
    await Promise.allSettled(closing);
    const callback = this.#callback;
    this.#callback = undefined;
    await callback?.then((server) => server.close()).catch(() => {});
  }

  views(): McpServerView[] {
    return [...this.#servers.values()].map((connection) => this.#view(connection));
  }

  onChange(listener: (view: McpServerView) => void) {
    this.#changeListeners.add(listener);
    return () => this.#changeListeners.delete(listener);
  }

  onRemoved(listener: (id: number) => void) {
    this.#removedListeners.add(listener);
    return () => this.#removedListeners.delete(listener);
  }

  // ── settings ─────────────────────────────────────────────────────────────────

  /**
   * Add a server (no `id`) or change one, then (re)connect it. Throws an `McpServerError` the user can
   * read when something's missing or wrong. A secret sent without a value keeps the stored one.
   */
  save(id: number | undefined, name: string, config: McpServerConfig): number {
    const existing = id === undefined ? undefined : this.#get(id);
    name = String(name ?? "").trim().replace(/\s+/g, " ");
    if (!name) throw new McpServerError("Give the server a name.");
    if (name.length > MAX_MCP_NAME) throw new McpServerError(`Keep the name under ${MAX_MCP_NAME + 1} characters.`);
    if (!slug(name)) throw new McpServerError("Use some letters or digits in the name.");
    // Its tools would clash with Top's own (collar/index.ts).
    if (slug(name) === COLLAR) throw new McpServerError(`${name} is the name of Top's own tools. Pick another.`);
    for (const other of this.#servers.values()) {
      if (other.id === id) continue;
      if (other.name.toLowerCase() === name.toLowerCase()) throw new McpServerError(`There's already a server named ${other.name}.`);
      // Their tools would get the same names.
      if (slug(other.name) === slug(name)) throw new McpServerError(`That name is too close to ${other.name}. Pick one that differs in more than punctuation.`);
    }
    const clean = this.#validate(config, existing?.config);
    // Credentials belong to one server: a new URL (or a switch to a program) signs in again.
    const resetOAuth = existing !== undefined && (existing.config.transport !== "http" || clean.transport !== "http" || existing.config.url !== clean.url);

    if (existing) {
      this.#store.updateMcpServer(existing.id, name, JSON.stringify(clean), resetOAuth);
      existing.name = name;
      existing.config = clean;
      void this.#connect(existing);
      return existing.id;
    }
    const newId = this.#store.createMcpServer(name, JSON.stringify(clean));
    const connection: Connection = {
      id: newId,
      name,
      config: clean,
      bots: new Set(),
      state: "connecting",
      error: undefined,
      tools: [],
      client: undefined,
      generation: 0,
      failures: 0,
      retryTimer: undefined,
    };
    this.#servers.set(newId, connection);
    void this.#connect(connection);
    return newId;
  }

  delete(id: number) {
    const connection = this.#get(id);
    this.#servers.delete(id);
    this.#store.deleteMcpServer(id);
    void this.#disconnect(connection);
    for (const listener of this.#removedListeners) listener(id);
  }

  /** Give a bot a server's tools, or take them away. They change from the bot's next run. */
  assign(id: number, bot: number, on: boolean) {
    const connection = this.#get(id);
    if (connection.bots.has(bot) === on) return;
    this.#store.assignMcp(id, bot, on);
    if (on) connection.bots.add(bot);
    else connection.bots.delete(bot);
    this.#changed(connection);
  }

  /** A bot was deleted (the store already dropped its assignments). */
  botRemoved(bot: number) {
    for (const connection of this.#servers.values()) {
      if (connection.bots.delete(bot)) this.#changed(connection);
    }
  }

  retry(id: number) {
    void this.#connect(this.#get(id));
  }

  /** Forget the server's OAuth credentials and reconnect, which asks for a new sign-in. */
  signOut(id: number) {
    const connection = this.#get(id);
    this.#store.setMcpOAuth(id, null);
    void this.#connect(connection);
  }

  /**
   * Start signing in: answers with the page to open in a browser on this computer. When the browser
   * comes back with the grant, the server reconnects with it.
   */
  async signIn(id: number): Promise<string> {
    const connection = this.#get(id);
    const config = connection.config;
    if (config.transport !== "http") throw new McpServerError(`${connection.name} runs as a program; it has no sign-in.`);
    if (hasAuthorization(config)) throw new McpServerError(`${connection.name} signs in with its Authorization header. Remove the header to sign in with OAuth instead.`);

    let authorizationUrl: string | undefined;
    const provider = this.#oauthProvider(connection, (url) => (authorizationUrl = url.href));
    // Registered for another redirect (the daemon's port changed): register again.
    const client = await provider.clientInformation();
    if (client && "redirect_uris" in client && Array.isArray(client.redirect_uris) && !client.redirect_uris.includes(this.#redirectUrl)) {
      await provider.invalidateCredentials("client");
    }
    const callback = await this.#callbackServer();
    let result;
    try {
      result = await authorizeMcp(provider, { serverUrl: config.url, skipRefresh: true });
    } catch (error) {
      throw new McpServerError(`Couldn't start signing in to ${connection.name}: ${messageOf(error)}`);
    }
    if (result === "AUTHORIZED" || !authorizationUrl) {
      void this.#connect(connection);
      throw new McpServerError(`${connection.name} is already signed in.`);
    }
    const state = await provider.state();
    if (!this.#waiting.has(state)) {
      this.#waiting.add(state);
      const generation = connection.generation;
      void callback
        .waitForCallback(state)
        .then(async ({ code, iss }) => {
          await authorizeMcp(provider, { serverUrl: config.url, authorizationCode: code, ...(iss ? { iss } : {}) });
          if (this.#servers.get(id) === connection) void this.#connect(connection);
        })
        .catch((error) => {
          if (this.#servers.get(id) !== connection || connection.generation !== generation) return;
          connection.error = `Signing in didn't finish: ${messageOf(error)}`;
          this.#changed(connection);
        })
        .finally(() => {
          this.#waiting.delete(state);
          if (this.#waiting.size === 0) void this.#closeCallbackServer();
        });
    }
    return authorizationUrl;
  }

  // ── tools ────────────────────────────────────────────────────────────────────

  /** The tools a bot gets from its connected servers. */
  toolsFor(bot: number): TopTool[] {
    const tools: TopTool[] = [];
    for (const connection of this.#servers.values()) {
      if (!connection.bots.has(bot) || connection.state !== "ready") continue;
      for (const tool of connection.tools) tools.push(this.#adapt(connection, tool));
    }
    return tools;
  }

  #adapt(connection: Connection, tool: Tool): TopTool {
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
      run: async (args, ctx): Promise<ToolResult> => {
        // Looked up per call: the server may have reconnected (a new client) or been removed since.
        const current = this.#servers.get(id);
        if (!current?.client || current.state !== "ready") {
          throw new Error(`The MCP server "${server}" isn't connected${current?.error ? `: ${current.error}` : ""}.`);
        }
        const result = await current.client.callTool(tool.name, args, { ...(ctx.signal ? { signal: ctx.signal } : {}), timeoutMs: CALL_TIMEOUT_MS });
        return { content: toLlmContent(result), details: {}, isError: result.isError === true } as ToolResult;
      },
    };
  }

  // ── connecting ───────────────────────────────────────────────────────────────

  async #connect(connection: Connection) {
    if (this.#closed) return;
    const generation = ++connection.generation;
    clearTimeout(connection.retryTimer);
    connection.retryTimer = undefined;
    const previous = connection.client;
    connection.client = undefined;
    connection.tools = [];
    connection.state = "connecting";
    connection.error = undefined;
    this.#changed(connection);
    await previous?.close().catch(() => {});

    const client = new McpClient({ ...(this.#options.clientInfo ?? { name: "top", version: "0.0.0" }), requestTimeoutMs: CONNECT_TIMEOUT_MS });
    let transport: McpTransport | undefined;
    const current = () => this.#servers.get(connection.id) === connection && connection.generation === generation && !this.#closed;
    try {
      transport = this.#transport(connection);
      await client.connect(transport);
      const tools = await client.listTools();
      if (!current()) return void client.close().catch(() => {});
      connection.client = client;
      connection.tools = tools;
      connection.state = "ready";
      connection.failures = 0;
      this.#changed(connection);
      client.onNotification("notifications/tools/list_changed", () => {
        void client.listTools().then(
          (next) => {
            if (!current() || connection.client !== client) return;
            connection.tools = next;
            this.#changed(connection);
          },
          () => {},
        );
      });
      client.onClose(() => {
        if (!current() || connection.client !== client) return;
        connection.client = undefined;
        connection.tools = [];
        this.#failed(connection, "The connection closed.", generation);
      });
    } catch (error) {
      void client.close().catch(() => {});
      if (!current()) return;
      if (error instanceof McpOAuthAuthorizationRequiredError) {
        connection.state = "signin";
        connection.error = undefined;
        this.#changed(connection);
        return;
      }
      if (error instanceof McpAuthRequiredError) {
        // Only with an Authorization header of the user's (otherwise OAuth handles a 401): it was refused.
        return this.#failed(connection, "The server refused the credentials (HTTP 401). Check the Authorization header.", generation, false);
      }
      const stderr = transport instanceof StdioTransport ? lastLines(transport.stderr) : "";
      this.#failed(connection, messageOf(error) + (stderr ? `\n${stderr}` : ""), generation);
    }
  }

  #failed(connection: Connection, error: string, generation: number, retry = true) {
    connection.state = "failed";
    connection.error = error;
    this.#changed(connection);
    if (!retry) return;
    const delay = RETRY_DELAYS_MS[Math.min(connection.failures, RETRY_DELAYS_MS.length - 1)]!;
    connection.failures++;
    connection.retryTimer = setTimeout(() => {
      if (connection.generation === generation) void this.#connect(connection);
    }, delay);
    connection.retryTimer.unref?.();
  }

  async #disconnect(connection: Connection) {
    connection.generation++;
    clearTimeout(connection.retryTimer);
    const client = connection.client;
    connection.client = undefined;
    connection.tools = [];
    await client?.close().catch(() => {});
  }

  #transport(connection: Connection): McpTransport {
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
      ...(hasAuthorization(config) ? {} : { authProvider: adaptOAuthProvider(this.#oauthProvider(connection, () => {})) }),
    });
  }

  /** OAuth for one server, its credentials kept in the store (so each connection is its own account). */
  #oauthProvider(connection: Connection, onRedirect: (url: URL) => void): McpOAuthProvider {
    const config = connection.config;
    if (config.transport !== "http") throw new Error("OAuth needs an HTTP server");
    const { id } = connection;
    return new McpOAuthProvider({
      serverUrl: config.url,
      redirectUrl: this.#redirectUrl,
      clientMetadata: { client_name: "Top", redirect_uris: [this.#redirectUrl] },
      store: {
        load: () => {
          const raw = this.#store.mcpServer(id)?.oauth;
          return raw ? (JSON.parse(raw) as McpOAuthState) : undefined;
        },
        save: (state) => {
          if (!this.#store.mcpServer(id)) return;
          const hadTokens = this.#signedIn(id);
          this.#store.setMcpOAuth(id, JSON.stringify(state));
          if (hadTokens !== this.#signedIn(id) && this.#servers.get(id) === connection) this.#changed(connection);
        },
      },
      onRedirect,
    });
  }

  #signedIn(id: number): boolean {
    const raw = this.#store.mcpServer(id)?.oauth;
    return raw ? (JSON.parse(raw) as McpOAuthState).tokens !== undefined : false;
  }

  #callbackServer(): Promise<OAuthCallbackServer> {
    this.#callback ??= OAuthCallbackServer.listen({
      host: "127.0.0.1",
      port: this.#options.oauthPort,
      path: CALLBACK_PATH,
      timeoutMs: SIGN_IN_TIMEOUT_MS,
      renderPage: (page) =>
        `<!doctype html><meta charset="utf-8"><title>Top</title><body style="font:15px system-ui;margin:3em;max-width:36em">` +
        (page.ok ? "<h2>Signed in</h2><p>You can close this tab and go back to Top.</p>" : `<h2>Couldn't sign in</h2><p>${escapeHtml(page.message)}</p>`),
    }).catch((error) => {
      this.#callback = undefined;
      throw new McpServerError(`Couldn't open the sign-in redirect on port ${this.#options.oauthPort}: ${messageOf(error)}`);
    });
    return this.#callback;
  }

  async #closeCallbackServer() {
    const callback = this.#callback;
    this.#callback = undefined;
    await callback?.then((server) => server.close()).catch(() => {});
  }

  // ── helpers ──────────────────────────────────────────────────────────────────

  #get(id: number): Connection {
    const connection = this.#servers.get(id);
    if (!connection) throw new McpServerError("That MCP server was removed.");
    return connection;
  }

  /** Check a config from a client and fill in the secrets it left out from `previous`. */
  #validate(config: McpServerConfig, previous: McpServerConfig | undefined): McpServerConfig {
    if (config?.transport === "stdio") {
      const command = String(config.command ?? "").trim();
      if (!command) throw new McpServerError("Give the command that starts the server.");
      const args = Array.isArray(config.args) ? config.args.map(String) : [];
      const env = secrets(config.env, previous?.transport === "stdio" ? previous.env : [], false, "variable");
      for (const v of env) if (!ENV_NAME.test(v.name)) throw new McpServerError(`"${v.name}" isn't a valid environment variable name.`);
      return { transport: "stdio", command, args, env };
    }
    if (config?.transport === "http") {
      const url = String(config.url ?? "").trim();
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new McpServerError("Give the server's full URL, starting with https://.");
      }
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new McpServerError("The URL has to start with https:// or http://.");
      const headers = secrets(config.headers, previous?.transport === "http" ? previous.headers : [], true, "header");
      for (const h of headers) if (!HEADER_NAME.test(h.name)) throw new McpServerError(`"${h.name}" isn't a valid header name.`);
      return { transport: "http", url: parsed.href, headers };
    }
    throw new McpServerError("Choose how to reach the server: a command or a URL.");
  }

  #view(connection: Connection): McpServerView {
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
      ...(this.#signedIn(connection.id) ? { signedIn: true as const } : {}),
    };
  }

  #changed(connection: Connection) {
    if (this.#servers.get(connection.id) !== connection) return;
    const view = this.#view(connection);
    for (const listener of this.#changeListeners) listener(view);
  }
}

/**
 * The secrets a client sent, with stored values for those it sent without one. A name may appear once
 * (headers ignore case).
 */
function secrets(sent: readonly McpSecret[] | undefined, stored: readonly McpSecret[], ignoreCase: boolean, what: string): McpSecret[] {
  const key = (name: string) => (ignoreCase ? name.toLowerCase() : name);
  const before = new Map(stored.map((s) => [key(s.name), s.value]));
  const seen = new Set<string>();
  const result: McpSecret[] = [];
  for (const secret of Array.isArray(sent) ? sent : []) {
    const name = String(secret?.name ?? "").trim();
    if (!name) continue;
    if (seen.has(key(name))) throw new McpServerError(`The ${what} ${name} is there twice.`);
    seen.add(key(name));
    const value = secret.value === undefined ? before.get(key(name)) : String(secret.value);
    if (value === undefined) throw new McpServerError(`Give the ${what} ${name} a value.`);
    result.push({ name, value });
  }
  return result;
}

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
