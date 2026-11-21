import {
  type AccountView,
  Attachment,
  type BotId,
  type BotSummary,
  type Channel,
  type ContextFileName,
  type ContextFileView,
  type FileView,
  type McpServerConfig,
  type McpServerId,
  type McpServerView,
  PROTOCOL_VERSION,
  type QuestionReply,
  type ResultOf,
  type ServerFrame,
  type SkillFolder,
  type SkillFolderAdded,
  type SkillsView,
  type TaskAnswers,
  type UpdateView,
  type Viewer,
  type WaitingAsk,
  type WaitingTask,
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
  ActiveSkill,
  AgentSpawn,
  Ask,
  AskKind,
  AskOutcome,
  Attachment,
  BotId,
  BotSkills,
  BotStatus,
  Channel,
  Citation,
  ContextFileName,
  ContextFileView,
  Entry,
  FileChange,
  FileView,
  Gap,
  McpSecret,
  McpServerConfig,
  McpServerId,
  McpServerState,
  McpServerView,
  PermissionAsk,
  QuestionAsk,
  QuestionOption,
  QuestionReply,
  QueuedMessage,
  SecretAsk,
  Seq,
  SkillFolder,
  SkillFolderAdded,
  SkillFolderEntry,
  SkillSource,
  SkillsView,
  SkillUse,
  SkillView,
  TaskAnswers,
  TaskInputView,
  TaskQuestion,
  ToolCallView,
  ToolOutcome,
  UpdateRelease,
  UpdateView,
  Viewer,
  WaitingAsk,
  WaitingTask,
  WebSearchStep,
  WhenBusy,
} from "@top/protocol";
export {
  activeSkills,
  BotSummary,
  CHANNELS,
  CHATGPT_BACKGROUND_NOTICE,
  CHATGPT_REDIRECT,
  CHATGPT_USAGE_URL,
  CONTEXT_FILES,
  channelName,
  channelOf,
  compareVersions,
  isModelImage,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  MAX_BOT_AVATAR,
  MAX_BOT_DESCRIPTION,
  MAX_BOT_NAME,
  MAX_CONTEXT_FILE_BYTES,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_EDGE,
  MAX_MCP_NAME,
  MAX_TASK_ANSWER,
  MODEL_IMAGE_TYPES,
  skillInvocation,
  taskEnded,
} from "@top/protocol";
export { type Connection, type ConnectionStatus, makeConnection, OfflineError, RequestError, type RequestFailure, TimeoutError } from "./connection.ts";
export * from "./conversation.ts";

export class UploadError extends Schema.TaggedError<UploadError>()("UploadError", { message: Schema.String }) {}

export class UploadCancelled extends Schema.TaggedError<UploadCancelled>()("AbortError", { message: Schema.String }) {}

export type TopClientOptions = {
  readonly url: string;
  readonly clientId?: string;
  readonly WebSocket?: typeof WebSocket;
  readonly serverId?: string;
  readonly pingIntervalMs?: number;
  readonly deadAfterMs?: number;
};

export type BotFiles = {
  readonly folder: string;
  readonly files: readonly FileView[];
  readonly more: boolean;
};

export type TopSnapshot = {
  readonly connection: ConnectionStatus;
  readonly rttMs: number | undefined;
  readonly attempt: number;
  readonly serverId: string | undefined;
  readonly bots: readonly BotSummary[];
  readonly mcpServers: readonly McpServerView[];
  readonly skills: SkillsView | undefined;
  readonly account: AccountView | undefined;
  readonly files: Readonly<Record<BotId, BotFiles>>;
  readonly hasFiles: boolean;
  readonly ready: boolean;
  readonly tailnetUrl: string | undefined;
  readonly viewer: Viewer | undefined;
  readonly server: { readonly version: string | undefined; readonly channel: Channel | undefined } | undefined;
  readonly update: UpdateView | undefined;
  readonly asks: readonly WaitingAsk[];
  readonly waitingTasks: readonly WaitingTask[];
  readonly outdated: "client" | "server" | undefined;
};

export type AskTarget = { readonly id: number; readonly bot: BotId };

/** The bots with those in `ids` in that order first, the rest after them as they were. */
function inOrder(bots: readonly BotSummary[], ids: readonly BotId[]): BotSummary[] {
  const rank = new Map(ids.map((id, i) => [id, i]));
  const ranked = (b: BotSummary) => rank.get(b.id) ?? ids.length + bots.indexOf(b);
  return [...bots].sort((a, b) => ranked(a) - ranked(b));
}

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
  /** Counts lists from the daemon and reorders made here, so an undone reorder can tell whether it's still the latest. */
  #rosterTurn = 0;
  /** The order in the daemon's last list: what a refused reorder goes back to. */
  #confirmedOrder: readonly BotId[] = [];
  readonly #listeners = new Set<() => void>();
  readonly #url: string;
  #filesPath: string | undefined;
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
      skills: undefined,
      account: undefined,
      files: {},
      hasFiles: false,
      ready: false,
      tailnetUrl: undefined,
      viewer: undefined,
      server: undefined,
      update: undefined,
      asks: [],
      waitingTasks: [],
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
              ...(status !== "open" && this.#snapshot.asks.length ? { asks: [] } : {}),
            });
          },
        },
      ).pipe(Scope.provide(this.#scope)),
    );
    this.#connection.serverId = options.serverId;
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

  hydrateBots(bots: readonly BotSummary[]) {
    if (!this.#snapshot.ready && this.#snapshot.bots.length === 0) this.#publish({ bots });
  }

  kick() {
    this.#run.fork(this.#connection.kick);
  }

  createBot(name: string, description: string, avatar = 0): Promise<BotId> {
    return this.#request({ t: "createBot", name, description, ...(avatar ? { avatar } : {}) }).then(({ id }) => id);
  }

  deleteBot(id: BotId): Promise<void> {
    return this.#command({ t: "deleteBot", bot: id });
  }

  /**
   * Lists the bots in this order here at once, and on every client once the daemon has it. When the daemon doesn't take
   * it, the daemon's last order comes back, unless a newer list or reorder has arrived since.
   */
  setBotOrder(ids: readonly BotId[]): Promise<void> {
    const turn = ++this.#rosterTurn;
    this.#publish({ bots: inOrder(this.#snapshot.bots, ids) });
    return this.#command({ t: "setBotOrder", bots: ids }).catch((error: unknown) => {
      if (this.#rosterTurn === turn) this.#publish({ bots: inOrder(this.#snapshot.bots, this.#confirmedOrder) });
      throw error;
    });
  }

  contextFiles(bot: BotId): Promise<readonly ContextFileView[]> {
    return this.#request({ t: "contextFiles", bot });
  }

  saveContextFile(bot: BotId, name: ContextFileName, content: string, version: string): Promise<string> {
    return this.#request({ t: "saveContextFile", bot, name, content, version }).then((result) => result.version);
  }

  saveMcpServer(id: McpServerId | undefined, name: string, config: McpServerConfig): Promise<McpServerId> {
    return this.#request({ t: "saveMcpServer", ...(id === undefined ? {} : { id }), name, config }).then((result) => result.id);
  }

  deleteMcpServer(id: McpServerId): Promise<void> {
    return this.#command({ t: "deleteMcpServer", id });
  }

  assignMcp(server: McpServerId, bot: BotId, on: boolean): Promise<void> {
    return this.#command({ t: "assignMcp", server, bot, on });
  }

  enableSkills(bot: BotId, names: readonly string[], on: boolean): Promise<void> {
    return this.#command({ t: "enableSkills", bot, names, on });
  }

  /** What adding a folder of skills (on the daemon's computer) would link, and what it would leave out. Changes nothing. */
  previewSkillFolder(folder: string): Promise<SkillFolder> {
    return this.#request({ t: "previewSkillFolder", folder });
  }

  /** Links the folder's new skills into the shared library and switches its usable ones on for `bots`. */
  addSkillFolder(folder: string, bots: readonly BotId[]): Promise<SkillFolderAdded> {
    return this.#request({ t: "addSkillFolder", folder, bots });
  }

  rescanSkills(): Promise<void> {
    return this.#command({ t: "rescanSkills" });
  }

  mcpSignIn(id: McpServerId): Promise<string> {
    return this.#request({ t: "mcpSignIn", id }).then(({ url }) => url);
  }

  mcpSignOut(id: McpServerId): Promise<void> {
    return this.#command({ t: "mcpSignOut", id });
  }

  chatgptSignIn(): Promise<string> {
    return this.#request({ t: "chatgptSignIn", backgroundConsent: true }).then(({ url }) => url);
  }

  chatgptSignInFinish(url: string): Promise<void> {
    return this.#command({ t: "chatgptSignInFinish", url });
  }

  chatgptSignInCancel(): Promise<void> {
    return this.#command({ t: "chatgptSignInCancel" });
  }

  chatgptSignOut(): Promise<void> {
    return this.#command({ t: "chatgptSignOut" });
  }

  mcpRetry(id: McpServerId): Promise<void> {
    return this.#command({ t: "mcpRetry", id });
  }

  checkForUpdate(): Promise<void> {
    return this.#command({ t: "checkForUpdate" });
  }

  installUpdate(version: string): Promise<void> {
    return this.#command({ t: "installUpdate", version });
  }

  setUpdateChannel(channel: Channel): Promise<void> {
    return this.#command({ t: "setUpdateChannel", channel });
  }

  answerPermission(request: AskTarget, allow: boolean): Promise<void> {
    return this.#command({ t: "answer", id: request.id, bot: request.bot, reply: { kind: "permission", allow } });
  }

  answerQuestion(request: AskTarget, reply: QuestionReply): Promise<void> {
    return this.#command({ t: "answer", id: request.id, bot: request.bot, reply: { kind: "question", ...reply } });
  }

  decline(request: AskTarget): Promise<void> {
    return this.#command({ t: "answer", id: request.id, bot: request.bot, reply: { kind: "decline" } });
  }

  saveSecret(request: AskTarget, value: string): Promise<void> {
    return this.#command({ t: "saveSecret", id: request.id, bot: request.bot, value });
  }

  answerTask(task: string, input: number, answers: TaskAnswers): Promise<void> {
    return this.#command({ t: "answerTask", task, input, answers });
  }

  #request<F extends RequestFrame>(frame: F): Promise<ResultOf<F["t"]>> {
    return this.#run.promise(this.#connection.request(frame));
  }

  #command(frame: RequestFrame): Promise<void> {
    return this.#run.promise(Effect.asVoid(this.#connection.request(frame)));
  }

  fileUrl(bot: BotId, path: string): string | undefined {
    if (this.#filesPath === undefined) return undefined;
    const base = new URL(this.#url);
    base.protocol = base.protocol === "wss:" ? "https:" : "http:";
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    return `${base.origin}${this.#filesPath}/${bot}/${encoded}`;
  }

  #httpOrigin(): string {
    const base = new URL(this.#url);
    base.protocol = base.protocol === "wss:" ? "https:" : "http:";
    return base.origin;
  }

  get canAttach(): boolean {
    return this.#attachmentsPath !== undefined;
  }

  attachmentUrl(id: string): string | undefined {
    return this.#attachmentsPath === undefined ? undefined : `${this.#httpOrigin()}${this.#attachmentsPath}/${encodeURIComponent(id)}`;
  }

  upload(file: Blob, name: string, options: { onProgress?: (fraction: number) => void; signal?: AbortSignal } = {}): Promise<Attachment> {
    const path = this.#attachmentsPath;
    if (path === undefined) return Promise.reject(new Error("Not connected to the daemon."));
    const url = `${this.#httpOrigin()}${path}/upload?name=${encodeURIComponent(name)}`;
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
        if ((frame.filesPath !== undefined) !== this.#snapshot.hasFiles) this.#publish({ hasFiles: frame.filesPath !== undefined });
        if (frame.tailnetUrl !== this.#snapshot.tailnetUrl || JSON.stringify(frame.viewer) !== JSON.stringify(this.#snapshot.viewer))
          this.#publish({ tailnetUrl: frame.tailnetUrl, viewer: frame.viewer });
        if (frame.serverId === this.#snapshot.serverId) return;
        if (this.#snapshot.serverId !== undefined) for (const conversation of this.#conversations.values()) conversation.reset();
        this.#connection.serverId = frame.serverId;
        this.#publish({ serverId: frame.serverId });
        return;
      }
      case "bots": {
        this.#rosterTurn++;
        this.#confirmedOrder = frame.bots.map((b) => b.id);
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
      case "skills":
        this.#publish({ skills: frame.skills });
        return;
      case "account":
        this.#publish({ account: frame.account });
        return;
      case "update":
        this.#publish({ update: frame.update });
        return;
      case "asks":
        this.#publish({ asks: frame.asks });
        return;
      case "waitingTasks":
        this.#publish({ waitingTasks: frame.tasks });
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
