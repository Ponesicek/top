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
 *
 * Inside, the connection and everything waiting on the daemon run as Effects in the client's own scope;
 * `close()` ends them all. The outside stays plain: snapshots and listeners, and Promises.
 */
import {
  type AccountView,
  Attachment,
  type BotId,
  type BotSummary,
  type Channel,
  type FileView,
  type McpServerConfig,
  type McpServerId,
  type McpServerView,
  type PermissionRequest,
  PROTOCOL_VERSION,
  type ResultOf,
  type ServerFrame,
  type UpdateView,
  type Viewer,
} from "@top/protocol";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { type Connection, type ConnectionStatus, makeConnection, type RequestFrame } from "./connection.ts";
import { type ClientRuntime, ConversationSync } from "./conversation.ts";

const parseAttachment = Schema.decodeOption(Schema.fromJsonString(Attachment));

export type {
  AccountView,
  Attachment,
  BotId,
  BotStatus,
  Channel,
  Entry,
  FileChange,
  FileView,
  Gap,
  McpSecret,
  McpServerConfig,
  McpServerId,
  McpServerState,
  McpServerView,
  PermissionAnswer,
  PermissionAsk,
  PermissionRequest,
  QueuedMessage,
  Seq,
  ToolCallView,
  ToolOutcome,
  UpdateRelease,
  UpdateView,
  Viewer,
  WhenBusy,
} from "@top/protocol";
export {
  BotSummary,
  CHANNELS,
  CHATGPT_BACKGROUND_NOTICE,
  CHATGPT_REDIRECT,
  CHATGPT_USAGE_URL,
  channelName,
  channelOf,
  compareVersions,
  isModelImage,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  MAX_BOT_AVATAR,
  MAX_BOT_DESCRIPTION,
  MAX_BOT_NAME,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_EDGE,
  MAX_MCP_NAME,
  MAX_PERMISSION_ACTION,
  MAX_PERMISSION_REASON,
  MODEL_IMAGE_TYPES,
} from "@top/protocol";
export { type Connection, type ConnectionStatus, makeConnection, OfflineError, RequestError, type RequestFailure, TimeoutError } from "./connection.ts";
export * from "./conversation.ts";

/** An upload the daemon refused (its reason, for the user) or that couldn't reach it. */
export class UploadError extends Schema.TaggedError<UploadError>()("UploadError", { message: Schema.String }) {}

/** An upload cancelled through its signal. Named like the web's own cancellation, `AbortError`. */
export class UploadCancelled extends Schema.TaggedError<UploadCancelled>()("AbortError", { message: Schema.String }) {}

export type TopClientOptions = {
  readonly url: string;
  readonly clientId?: string;
  readonly WebSocket?: typeof WebSocket;
  /** The daemon a cache being hydrated came from (`getSnapshot().serverId` when it was saved). */
  readonly serverId?: string;
  readonly pingIntervalMs?: number;
  readonly deadAfterMs?: number;
};

/** A bot's files folder (see the protocol's FileView). */
export type BotFiles = {
  /** The folder's absolute path on the daemon's computer. */
  readonly folder: string;
  readonly files: readonly FileView[];
  /** The folder holds more files than were sent. */
  readonly more: boolean;
};

export type TopSnapshot = {
  readonly connection: ConnectionStatus;
  readonly rttMs: number | undefined;
  readonly attempt: number;
  /**
   * Names the daemon's data. It changes when the client meets a different daemon (another `--home`,
   * or a reset), and everything held from the old one is dropped; a UI should drop its own cache then.
   */
  readonly serverId: string | undefined;
  readonly bots: readonly BotSummary[];
  /** The MCP servers set up on the daemon (empty until it says). */
  readonly mcpServers: readonly McpServerView[];
  /** What the bots' model requests are signed in with; `undefined` until the daemon says, and on one with fake bots. */
  readonly account: AccountView | undefined;
  /** The files folders of the bots being watched, once the daemon has listed them. */
  readonly files: Readonly<Record<BotId, BotFiles>>;
  /** Set once the first roster arrived; the UI can render from cache before that. */
  readonly ready: boolean;
  /** Where the daemon is on the user's tailnet, if it's there (`--tailscale`). */
  readonly tailnetUrl: string | undefined;
  /** Who Tailscale says this client is, when it connected over the tailnet. */
  readonly viewer: Viewer | undefined;
  /** The daemon's version, and the releases it follows (`channel` is absent on one run from a checkout). */
  readonly server: { readonly version: string | undefined; readonly channel: Channel | undefined } | undefined;
  /** The daemon's updates; `undefined` on one that doesn't update itself (run from a checkout, or not installed). */
  readonly update: UpdateView | undefined;
  /**
   * Bots' permission requests waiting for an answer, oldest first. Empty while disconnected: they can't
   * be answered then, and the daemon sends them again on reconnect (minus any answered meanwhile).
   */
  readonly permissions: readonly PermissionRequest[];
  /**
   * The daemon speaks another version of the protocol, so this client can't work with it: `client`
   * when this client is the older one (update the app), `server` when the daemon is.
   */
  readonly outdated: "client" | "server" | undefined;
};

export class TopClient {
  readonly clientId: string;
  readonly #scope = Scope.makeUnsafe();
  readonly #run: ClientRuntime = {
    promise: (effect) => Effect.runPromise(effect),
    fork: (effect) => {
      Effect.runFork(Effect.forkIn(effect, this.#scope));
    },
  };
  readonly #connection: Connection;
  readonly #conversations = new Map<BotId, ConversationSync>();
  readonly #listeners = new Set<() => void>();
  readonly #url: string;
  /** Where the daemon serves files, from `welcome` (see the protocol's FileView). */
  #filesPath: string | undefined;
  /** Where the daemon takes and serves attachments, from `welcome` (see the protocol's Attachment). */
  #attachmentsPath: string | undefined;
  #snapshot: TopSnapshot;

  constructor(options: TopClientOptions) {
    this.clientId = options.clientId ?? `client-${Math.random().toString(36).slice(2, 10)}`;
    this.#url = options.url;
    this.#snapshot = {
      connection: "connecting",
      rttMs: undefined,
      attempt: 0,
      serverId: options.serverId,
      bots: [],
      mcpServers: [],
      account: undefined,
      files: {},
      ready: false,
      tailnetUrl: undefined,
      viewer: undefined,
      server: undefined,
      update: undefined,
      permissions: [],
      outdated: undefined,
    };
    this.#connection = Effect.runSync(
      makeConnection(
        {
          url: options.url,
          clientId: this.clientId,
          WebSocket: options.WebSocket,
          ...(options.pingIntervalMs ? { pingIntervalMs: options.pingIntervalMs } : {}),
          ...(options.deadAfterMs ? { deadAfterMs: options.deadAfterMs } : {}),
        },
        {
          onFrame: (frame) => this.#receive(frame),
          onOpen: () => {
            for (const conversation of this.#conversations.values()) conversation.attach();
          },
          onStatus: () => {
            const status = this.#connection.status();
            if (status !== "open") for (const conversation of this.#conversations.values()) conversation.disconnected();
            this.#publish({
              connection: status,
              attempt: this.#connection.attempt(),
              ...(status !== "open" && this.#snapshot.permissions.length ? { permissions: [] } : {}),
            });
          },
        },
      ).pipe(Scope.provide(this.#scope)),
    );
    this.#connection.serverId = options.serverId;
    // RTT is read lazily; refresh it in the snapshot now and then without a render per pong.
    this.#run.fork(
      Effect.repeat(
        Effect.sync(() => {
          const rttMs = this.#connection.rttMs();
          if (rttMs !== this.#snapshot.rttMs) this.#publish({ rttMs });
        }),
        Schedule.spaced(Duration.seconds(2)),
      ),
    );
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
    this.#run.fork(this.#connection.kick);
  }

  /**
   * Make a bot. Resolves with its id once it is in the roster; rejects with a message for the user when
   * the daemon refuses it (an empty or taken name) or isn't reachable. `avatar` picks which drawing of the
   * name it wears (see BotSummary); 0, the default, is the name's own.
   */
  createBot(name: string, description: string, avatar = 0): Promise<BotId> {
    return this.#request({ t: "createBot", name, description, ...(avatar ? { avatar } : {}) }).then(({ id }) => id);
  }

  /** Delete a bot and its whole transcript, on the daemon and for every client. */
  deleteBot(id: BotId): Promise<void> {
    return this.#command({ t: "deleteBot", bot: id });
  }

  /**
   * Add an MCP server (no `id`) or change one. A secret without a `value` keeps the stored one.
   * Rejects with a message for the user when the daemon refuses it (a taken name, a bad URL).
   */
  saveMcpServer(id: McpServerId | undefined, name: string, config: McpServerConfig): Promise<McpServerId> {
    return this.#request({ t: "saveMcpServer", ...(id === undefined ? {} : { id }), name, config }).then((result) => result.id);
  }

  /** Remove an MCP server; its bots lose its tools and its credentials are erased. */
  deleteMcpServer(id: McpServerId): Promise<void> {
    return this.#command({ t: "deleteMcpServer", id });
  }

  /** Give a bot an MCP server's tools, or take them away. */
  assignMcp(server: McpServerId, bot: BotId, on: boolean): Promise<void> {
    return this.#command({ t: "assignMcp", server, bot, on });
  }

  /** Start signing in to an MCP server: resolves with the page to open (in a browser on the daemon's computer). */
  mcpSignIn(id: McpServerId): Promise<string> {
    return this.#request({ t: "mcpSignIn", id }).then(({ url }) => url);
  }

  /** Forget an MCP server's credentials, to sign in as someone else. */
  mcpSignOut(id: McpServerId): Promise<void> {
    return this.#command({ t: "mcpSignOut", id });
  }

  /**
   * Start signing in with ChatGPT; resolves with the page to open. Call it only once the user agreed
   * that the bots may use their plan in the background (`CHATGPT_BACKGROUND_NOTICE`).
   */
  chatgptSignIn(): Promise<string> {
    return this.#request({ t: "chatgptSignIn", backgroundConsent: true }).then(({ url }) => url);
  }

  /** Finish the sign-in under way with the address the browser ended on; resolves once the daemon is signed in. */
  chatgptSignInFinish(url: string): Promise<void> {
    return this.#command({ t: "chatgptSignInFinish", url });
  }

  chatgptSignInCancel(): Promise<void> {
    return this.#command({ t: "chatgptSignInCancel" });
  }

  /** Forget the ChatGPT sign-in. */
  chatgptSignOut(): Promise<void> {
    return this.#command({ t: "chatgptSignOut" });
  }

  /** Reconnect to an MCP server now. */
  mcpRetry(id: McpServerId): Promise<void> {
    return this.#command({ t: "mcpRetry", id });
  }

  /** Ask the daemon to look for a newer release on its channel now. */
  checkForUpdate(): Promise<void> {
    return this.#command({ t: "checkForUpdate" });
  }

  /** Update the daemon to `version` (the one `update.available` offers). It restarts, so the connection drops and comes back. */
  installUpdate(version: string): Promise<void> {
    return this.#command({ t: "installUpdate", version });
  }

  /** Which releases the daemon follows. */
  setUpdateChannel(channel: Channel): Promise<void> {
    return this.#command({ t: "setUpdateChannel", channel });
  }

  /**
   * Answer a bot's permission request. Rejects with a message for the user when it was answered already
   * (on another device too) or isn't waiting anymore; the daemon takes only the first answer.
   */
  answerPermission(request: Pick<PermissionRequest, "id" | "bot">, allow: boolean): Promise<void> {
    return this.#command({ t: "answerPermission", id: request.id, bot: request.bot, allow });
  }

  /** A request to the daemon, as a Promise for the UI: it rejects with the protocol's error (a message for the user). */
  #request<F extends RequestFrame>(frame: F): Promise<ResultOf<F["t"]>> {
    return this.#run.promise(this.#connection.request(frame));
  }

  #command(frame: RequestFrame): Promise<void> {
    return this.#run.promise(Effect.asVoid(this.#connection.request(frame)));
  }

  /**
   * The link to one of a bot's files, on the address this client reaches the daemon at (so it works
   * over Tailscale or a tunnel too). `undefined` until the daemon said where files are, or if it has none.
   */
  fileUrl(bot: BotId, path: string): string | undefined {
    if (this.#filesPath === undefined) return undefined;
    const base = new URL(this.#url);
    base.protocol = base.protocol === "wss:" ? "https:" : "http:";
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    return `${base.origin}${this.#filesPath}/${bot}/${encoded}`;
  }

  /** The daemon's HTTP origin, on the address this client reaches it at. */
  #httpOrigin(): string {
    const base = new URL(this.#url);
    base.protocol = base.protocol === "wss:" ? "https:" : "http:";
    return base.origin;
  }

  /** Whether the daemon takes attachments (known once connected). */
  get canAttach(): boolean {
    return this.#attachmentsPath !== undefined;
  }

  /** The link to an attachment, or `undefined` before the daemon said where they are. */
  attachmentUrl(id: string): string | undefined {
    return this.#attachmentsPath === undefined ? undefined : `${this.#httpOrigin()}${this.#attachmentsPath}/${encodeURIComponent(id)}`;
  }

  /**
   * Upload a file to attach to a message; send its id with the message (`ConversationSync.send`).
   * `onProgress` gets the fraction sent. Rejects with the daemon's reason (a sentence for the user).
   */
  upload(file: Blob, name: string, options: { onProgress?: (fraction: number) => void; signal?: AbortSignal } = {}): Promise<Attachment> {
    const path = this.#attachmentsPath;
    if (path === undefined) return Promise.reject(new Error("Not connected to the daemon."));
    const url = `${this.#httpOrigin()}${path}/upload?name=${encodeURIComponent(name)}`;
    // XHR, not fetch: only XHR reports upload progress.
    const sending = Effect.callback<Attachment, UploadError | UploadCancelled>((resume) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", url);
      if (file.type) xhr.setRequestHeader("Content-Type", file.type);
      xhr.upload.onprogress = (event) => event.lengthComputable && options.onProgress?.(event.loaded / event.total);
      xhr.onload = () => {
        if (xhr.status !== 200) return resume(Effect.fail(new UploadError({ message: xhr.responseText.trim() || `Upload failed (${xhr.status}).` })));
        const attachment = parseAttachment(xhr.responseText);
        resume(
          Option.isSome(attachment)
            ? Effect.succeed(attachment.value)
            : Effect.fail(new UploadError({ message: "Upload failed: the daemon's answer wasn't readable." })),
        );
      };
      xhr.onerror = () => resume(Effect.fail(new UploadError({ message: "Upload failed: couldn't reach the daemon." })));
      xhr.ontimeout = () => resume(Effect.fail(new UploadError({ message: "Upload timed out." })));
      xhr.onabort = () => resume(Effect.fail(new UploadCancelled({ message: "Upload cancelled." })));
      xhr.timeout = 5 * 60_000;
      options.signal?.addEventListener("abort", () => xhr.abort());
      xhr.send(file);
      return Effect.sync(() => xhr.abort());
    });
    return this.#run.promise(sending);
  }

  conversation(id: BotId): ConversationSync {
    let conversation = this.#conversations.get(id);
    if (!conversation) {
      conversation = new ConversationSync(id, this.#connection, this.clientId, this.#run);
      this.#conversations.set(id, conversation);
    }
    return conversation;
  }

  close() {
    Effect.runFork(Scope.close(this.#scope, Exit.void));
  }

  #receive(frame: ServerFrame) {
    switch (frame.t) {
      case "welcome": {
        const outdated = frame.protocol === PROTOCOL_VERSION ? undefined : frame.protocol > PROTOCOL_VERSION ? "client" : "server";
        if (outdated !== this.#snapshot.outdated) this.#publish({ outdated });
        if (frame.version !== this.#snapshot.server?.version || frame.channel !== this.#snapshot.server?.channel)
          this.#publish({ server: { version: frame.version, channel: frame.channel } });
        this.#filesPath = frame.filesPath;
        this.#attachmentsPath = frame.attachmentsPath;
        if (frame.tailnetUrl !== this.#snapshot.tailnetUrl || JSON.stringify(frame.viewer) !== JSON.stringify(this.#snapshot.viewer))
          this.#publish({ tailnetUrl: frame.tailnetUrl, viewer: frame.viewer });
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
      case "botRemoved": {
        this.#conversations.delete(frame.bot);
        const { [frame.bot]: _gone, ...files } = this.#snapshot.files;
        this.#publish({ bots: this.#snapshot.bots.filter((b) => b.id !== frame.bot), files });
        return;
      }
      case "files":
        this.#publish({ files: { ...this.#snapshot.files, [frame.bot]: { folder: frame.folder, files: frame.files, more: !!frame.more } } });
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
      case "account":
        this.#publish({ account: frame.account });
        return;
      case "update":
        this.#publish({ update: frame.update });
        return;
      case "permissions":
        this.#publish({ permissions: frame.requests });
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
