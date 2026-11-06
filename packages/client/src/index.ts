/**
 * @top/client: everything a Top UI needs except the pixels. Framework-free TypeScript, shared by the
 * Electron desktop app and the React Native app.
 *
 *   const top = new TopClient({ url: "ws://127.0.0.1:7357" });
 *   const bot = top.conversation(id); bot.retain();
 *   useSyncExternalStore(bot.subscribe, bot.getSnapshot);
 *
 * Retain only the bots on screen when data is metered (a phone on cellular): the sidebar summaries
 * cover the rest, and a retained bot catches up from what it holds when it is opened.
 */
import type { BotId, BotSummary, CreateBotResult, McpServerConfig, McpServerId, McpServerView, McpSignInResult, SaveMcpServerResult, ServerFrame } from "@top/protocol";
import { Connection, type ConnectionStatus } from "./connection.ts";
import { ConversationSync } from "./conversation.ts";

export * from "./conversation.ts";
export { Connection, OfflineError, TimeoutError, type ConnectionStatus } from "./connection.ts";
export { MAX_BOT_DESCRIPTION, MAX_BOT_NAME, MAX_MCP_NAME } from "@top/protocol";
export type {
  BotId,
  BotStatus,
  BotSummary,
  Entry,
  Gap,
  McpSecret,
  McpServerConfig,
  McpServerId,
  McpServerState,
  McpServerView,
  QueuedMessage,
  Seq,
  ToolCallView,
  ToolOutcome,
  WhenBusy,
} from "@top/protocol";

export type TopClientOptions = {
  readonly url: string;
  readonly clientId?: string;
  readonly WebSocket?: typeof WebSocket;
  /** The daemon a cache being hydrated came from (`getSnapshot().serverId` when it was saved). */
  readonly serverId?: string;
  readonly pingIntervalMs?: number;
  readonly deadAfterMs?: number;
};

export type TopSnapshot = {
  readonly connection: ConnectionStatus;
  readonly rttMs: number | undefined;
  readonly attempt: number;
  /**
   * Names the daemon's data. It changes when the client meets a different daemon (another `--data`,
   * or a reset), and everything held from the old one is dropped; a UI should drop its own cache then.
   */
  readonly serverId: string | undefined;
  readonly bots: readonly BotSummary[];
  /** The MCP servers set up on the daemon (empty until it says). */
  readonly mcpServers: readonly McpServerView[];
  /** Set once the first roster arrived; the UI can render from cache before that. */
  readonly ready: boolean;
};

export class TopClient {
  readonly clientId: string;
  readonly #connection: Connection;
  readonly #conversations = new Map<BotId, ConversationSync>();
  readonly #listeners = new Set<() => void>();
  readonly #rttTimer: ReturnType<typeof setInterval>;
  #snapshot: TopSnapshot;

  constructor(options: TopClientOptions) {
    this.clientId = options.clientId ?? `client-${Math.random().toString(36).slice(2, 10)}`;
    this.#snapshot = { connection: "connecting", rttMs: undefined, attempt: 0, serverId: options.serverId, bots: [], mcpServers: [], ready: false };
    this.#connection = new Connection({
      url: options.url,
      clientId: this.clientId,
      WebSocket: options.WebSocket,
      ...(options.pingIntervalMs ? { pingIntervalMs: options.pingIntervalMs } : {}),
      ...(options.deadAfterMs ? { deadAfterMs: options.deadAfterMs } : {}),
    });
    this.#connection.serverId = options.serverId;
    this.#connection.onFrame = (frame) => this.#receive(frame);
    this.#connection.onOpen = () => {
      for (const conversation of this.#conversations.values()) conversation.attach();
    };
    this.#connection.onStatus = () => {
      if (this.#connection.status !== "open") for (const conversation of this.#conversations.values()) conversation.disconnected();
      this.#publish({ connection: this.#connection.status, attempt: this.#connection.attempt });
    };
    this.#connection.start();
    // RTT is read lazily; refresh it in the snapshot now and then without a render per pong.
    this.#rttTimer = setInterval(() => {
      if (this.#connection.rttMs !== this.#snapshot.rttMs) this.#publish({ rttMs: this.#connection.rttMs });
    }, 2_000);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getSnapshot = (): TopSnapshot => this.#snapshot;

  /** Show a cached roster before the daemon answers. */
  hydrateBots(bots: readonly BotSummary[]) {
    if (!this.#snapshot.ready && this.#snapshot.bots.length === 0) this.#publish({ bots });
  }

  /**
   * The app came back to the foreground or the network changed: reconnect now if we're down, or
   * check right away that an open socket still works.
   */
  kick() {
    this.#connection.kick();
  }

  /**
   * Make a bot. Resolves with its id once it is in the roster; rejects with a message for the user when
   * the daemon refuses it (an empty or taken name) or isn't reachable.
   */
  async createBot(name: string, description: string): Promise<BotId> {
    const { id } = await this.#connection.request<CreateBotResult>({ t: "createBot", name, description });
    return id;
  }

  /** Delete a bot and its whole transcript, on the daemon and for every client. */
  async deleteBot(id: BotId): Promise<void> {
    await this.#connection.request({ t: "deleteBot", bot: id });
  }

  /**
   * Add an MCP server (no `id`) or change one. A secret without a `value` keeps the stored one.
   * Rejects with a message for the user when the daemon refuses it (a taken name, a bad URL).
   */
  async saveMcpServer(id: McpServerId | undefined, name: string, config: McpServerConfig): Promise<McpServerId> {
    const result = await this.#connection.request<SaveMcpServerResult>({ t: "saveMcpServer", ...(id === undefined ? {} : { id }), name, config });
    return result.id;
  }

  /** Remove an MCP server; its bots lose its tools and its credentials are erased. */
  async deleteMcpServer(id: McpServerId): Promise<void> {
    await this.#connection.request({ t: "deleteMcpServer", id });
  }

  /** Give a bot an MCP server's tools, or take them away. */
  async assignMcp(server: McpServerId, bot: BotId, on: boolean): Promise<void> {
    await this.#connection.request({ t: "assignMcp", server, bot, on });
  }

  /** Start signing in to an MCP server: resolves with the page to open (in a browser on the daemon's computer). */
  async mcpSignIn(id: McpServerId): Promise<string> {
    const { url } = await this.#connection.request<McpSignInResult>({ t: "mcpSignIn", id });
    return url;
  }

  /** Forget an MCP server's credentials, to sign in as someone else. */
  async mcpSignOut(id: McpServerId): Promise<void> {
    await this.#connection.request({ t: "mcpSignOut", id });
  }

  /** Reconnect to an MCP server now. */
  async mcpRetry(id: McpServerId): Promise<void> {
    await this.#connection.request({ t: "mcpRetry", id });
  }

  conversation(id: BotId): ConversationSync {
    let conversation = this.#conversations.get(id);
    if (!conversation) {
      conversation = new ConversationSync(id, this.#connection, this.clientId);
      this.#conversations.set(id, conversation);
    }
    return conversation;
  }

  close() {
    clearInterval(this.#rttTimer);
    this.#connection.close();
  }

  #receive(frame: ServerFrame) {
    switch (frame.t) {
      case "welcome": {
        if (frame.serverId === this.#snapshot.serverId) return;
        // Another daemon's data: what we hold is not its history. Its watches already ignore our
        // `after` (we said where our entries came from in `hello`), so the syncs that follow are fresh.
        if (this.#snapshot.serverId !== undefined) for (const conversation of this.#conversations.values()) conversation.reset();
        this.#connection.serverId = frame.serverId;
        this.#publish({ serverId: frame.serverId });
        return;
      }
      case "bots": {
        // Bots deleted while this client was away.
        const live = new Set(frame.bots.map((b) => b.id));
        for (const id of this.#conversations.keys()) if (!live.has(id)) this.#conversations.delete(id);
        this.#publish({ bots: frame.bots, ready: true });
        return;
      }
      case "botRemoved":
        this.#conversations.delete(frame.bot);
        this.#publish({ bots: this.#snapshot.bots.filter((b) => b.id !== frame.bot) });
        return;
      case "bot": {
        const bots = this.#snapshot.bots;
        const i = bots.findIndex((b) => b.id === frame.bot.id);
        this.#publish({ bots: i < 0 ? [...bots, frame.bot] : bots.map((b, j) => (j === i ? frame.bot : b)) });
        return;
      }
      case "mcpServers":
        this.#publish({ mcpServers: frame.servers });
        return;
      case "mcpServer": {
        const servers = this.#snapshot.mcpServers;
        const i = servers.findIndex((s) => s.id === frame.server.id);
        this.#publish({ mcpServers: i < 0 ? [...servers, frame.server] : servers.map((s, j) => (j === i ? frame.server : s)) });
        return;
      }
      case "mcpServerRemoved":
        this.#publish({ mcpServers: this.#snapshot.mcpServers.filter((s) => s.id !== frame.id) });
        return;
      case "sync":
        this.#conversations.get(frame.bot)?.receiveSync(frame);
        return;
      case "entry":
        this.#conversations.get(frame.entry.bot)?.receiveEntry(frame.entry);
        return;
      case "inbox":
        this.#conversations.get(frame.bot)?.receiveInbox(frame.items);
        return;
    }
  }

  #publish(change: Partial<TopSnapshot>) {
    this.#snapshot = { ...this.#snapshot, ...change };
    for (const listener of this.#listeners) listener();
  }
}
