/**
 * Top's wire protocol: JSON frames over one WebSocket (compressed with permessage-deflate) between
 * the Top daemon and its clients.
 *
 * Nothing streams. A bot's transcript is a list of finished, immutable entries, each with a sequence
 * number from one counter shared by all bots. A client says which entries it already has (`after`),
 * gets only the ones it is missing, then each new entry once. The sidebar gets one small summary per
 * bot that changed.
 */

export const PROTOCOL_VERSION = 2;
export const DEFAULT_PORT = 7357;

export type BotId = number;
/** Global, strictly increasing entry number. Entries of one bot are increasing but not contiguous. */
export type Seq = number;

export type BotStatus =
  /** Nothing running. */
  | "idle"
  /** Waiting on the model. */
  | "thinking"
  /** Running a tool (`tool` names it). */
  | "tool"
  /** The model request failed; retrying after a backoff. */
  | "retrying"
  /** The last run ended in an error it could not recover from. */
  | "failed";

export type BotSummary = {
  readonly id: BotId;
  readonly name: string;
  /** What the bot is for, as given when it was made. Empty when none was given. */
  readonly description: string;
  readonly status: BotStatus;
  /** The running tool's name while `status` is `tool`. */
  readonly tool?: string;
  /** When the current status began (ms since epoch), for an elapsed timer. */
  readonly since: number;
  /** The failure or retry reason, when there is one. */
  readonly error?: string;
  /** The last line of the bot's latest answer, for the sidebar. */
  readonly preview: string;
  /** Messages waiting behind the running task. */
  readonly queued: number;
  /** Newest entry of this bot, so a client can show "unread" without loading it. */
  readonly lastSeq: Seq;
};

export type ToolCallView = {
  readonly id: string;
  readonly name: string;
  /** The arguments, shortened to one line. */
  readonly summary: string;
};

/**
 * What happened to a tool call that was cut off by a daemon restart:
 * - `interrupted`: it may or may not have taken effect, and was not run again.
 * - `not_run`: the daemon stopped before the tool started.
 * - `recovered`: the tool checked its own outcome after the restart.
 * - `replayed`: the tool is safe to repeat, so it ran again.
 * - `stopped`: it kept crashing the daemon, so the task was ended.
 */
export type ToolOutcome = "interrupted" | "not_run" | "recovered" | "replayed" | "stopped";

type EntryBase = { readonly seq: Seq; readonly bot: BotId; readonly at: number };

export type Entry =
  | (EntryBase & { readonly kind: "user"; readonly text: string; readonly requestId?: string })
  | (EntryBase & {
      readonly kind: "assistant";
      readonly text: string;
      readonly tools?: readonly ToolCallView[];
      /** Thinking text exists; fetch it with `detail`. */
      readonly hasThinking?: true;
      /** Full thinking text, only in a `detail` answer. */
      readonly thinking?: string;
      readonly error?: string;
      readonly stopped?: true;
    })
  | (EntryBase & {
      readonly kind: "tool";
      readonly toolCallId: string;
      readonly name: string;
      /** The result text, shortened unless this came from `detail`. */
      readonly text: string;
      readonly truncated?: true;
      readonly isError?: true;
      readonly outcome?: ToolOutcome;
    })
  | (EntryBase & { readonly kind: "notice"; readonly text: string });

export type WhenBusy = "steer" | "followUp" | "reject";

export type QueuedMessage = {
  readonly requestId: string;
  readonly text: string;
  readonly mode: "steer" | "followUp";
  readonly at: number;
};

/** Entries strictly between `after` and `before` exist on the daemon but were not sent. */
export type Gap = { readonly after: Seq; readonly before: Seq };

// ── MCP servers ──────────────────────────────────────────────────────────────────
//
// MCP servers are set up once on the daemon and then assigned to bots; a bot has none until it is
// given one. Each is its own connection with its own credentials, so the same URL can be added twice
// (two accounts). Every bot it's assigned to shares that one connection.

export type McpServerId = number;

/**
 * An environment variable (stdio) or HTTP header whose value may be a secret. The daemon never sends
 * values back: in a view `value` is absent. When saving, an absent `value` keeps the stored one.
 */
export type McpSecret = { readonly name: string; readonly value?: string };

export type McpServerConfig =
  /** A local program the daemon starts, speaking MCP over stdin/stdout. */
  | { readonly transport: "stdio"; readonly command: string; readonly args: readonly string[]; readonly env: readonly McpSecret[] }
  /** A remote server over Streamable HTTP. Without an `Authorization` header, it signs in with OAuth if it asks. */
  | { readonly transport: "http"; readonly url: string; readonly headers: readonly McpSecret[] };

export type McpServerState =
  /** Starting the program or reaching the server. */
  | "connecting"
  /** Connected; its tools are offered to the bots it's assigned to. */
  | "ready"
  /** The server wants the user to sign in (OAuth) before it can be used. */
  | "signin"
  /** It couldn't be started or reached (`error` says why); it is retried now and then. */
  | "failed";

export type McpServerView = {
  readonly id: McpServerId;
  readonly name: string;
  /** Secret values are left out. */
  readonly config: McpServerConfig;
  /** The bots that have this server's tools. */
  readonly bots: readonly BotId[];
  readonly state: McpServerState;
  readonly error?: string;
  /** The server's tool names, while it is connected. */
  readonly tools: readonly string[];
  /** It holds OAuth credentials (an account is signed in). */
  readonly signedIn?: true;
};

/** The longest MCP server name `saveMcpServer` accepts. */
export const MAX_MCP_NAME = 40;

// ── client → daemon ──────────────────────────────────────────────────────────────

export type ClientFrame =
  /**
   * `serverId`: the daemon the client's entries came from (from an earlier `welcome`, or its cache).
   * If it isn't this daemon, the `after` of this connection's watches is ignored and the newest entries
   * are sent instead: those sequence numbers belong to another daemon's data.
   */
  | { readonly t: "hello"; readonly clientId: string; readonly protocol: typeof PROTOCOL_VERSION; readonly serverId?: string }
  /** Follow a bot. `after`: the newest entry the client holds; omit it to get the newest `limit`. */
  | { readonly t: "watch"; readonly bot: BotId; readonly after?: Seq; readonly limit?: number }
  | { readonly t: "unwatch"; readonly bot: BotId }
  /** Entries older than `before` (and newer than `after`, if given), newest first up to `limit`. */
  | { readonly t: "history"; readonly req: number; readonly bot: BotId; readonly before: Seq; readonly after?: Seq; readonly limit: number }
  /** One entry in full: untruncated tool output, thinking, tool arguments. */
  | { readonly t: "detail"; readonly req: number; readonly bot: BotId; readonly seq: Seq }
  | {
      readonly t: "submit";
      readonly req: number;
      readonly bot: BotId;
      /** Idempotency key: a resend after a drop is applied once. */
      readonly requestId: string;
      readonly text: string;
      readonly whenBusy: WhenBusy;
      readonly clientId: string;
    }
  | { readonly t: "abort"; readonly req: number; readonly bot: BotId }
  /** Make a bot. Answers with its id; every client gets its summary in a `bot` frame first. */
  | { readonly t: "createBot"; readonly req: number; readonly name: string; readonly description: string }
  /** Delete a bot and its whole transcript. Every client gets `botRemoved`. */
  | { readonly t: "deleteBot"; readonly req: number; readonly bot: BotId }
  /** Add an MCP server (no `id`) or change one. Answers with its id; every client gets an `mcpServer` frame. */
  | { readonly t: "saveMcpServer"; readonly req: number; readonly id?: McpServerId; readonly name: string; readonly config: McpServerConfig }
  /** Remove an MCP server: its bots lose its tools, and its credentials are erased. */
  | { readonly t: "deleteMcpServer"; readonly req: number; readonly id: McpServerId }
  /** Give a bot an MCP server's tools (`on`), or take them away. They change from the bot's next message. */
  | { readonly t: "assignMcp"; readonly req: number; readonly server: McpServerId; readonly bot: BotId; readonly on: boolean }
  /** Start signing in to an MCP server. Answers with the page to open in a browser on the daemon's computer. */
  | { readonly t: "mcpSignIn"; readonly req: number; readonly id: McpServerId }
  /** Forget an MCP server's credentials, to sign in again (as another account). */
  | { readonly t: "mcpSignOut"; readonly req: number; readonly id: McpServerId }
  /** Reconnect to an MCP server now instead of waiting for the next retry. */
  | { readonly t: "mcpRetry"; readonly req: number; readonly id: McpServerId }
  | { readonly t: "ping"; readonly at: number };

export type HistoryResult = { readonly entries: readonly Entry[]; /** More entries remain in the asked range. */ readonly more: boolean };
export type SubmitResult = { readonly duplicate: boolean };
export type CreateBotResult = { readonly id: BotId };
export type SaveMcpServerResult = { readonly id: McpServerId };
export type McpSignInResult = { readonly url: string };

/** The longest bot name and description `createBot` accepts. */
export const MAX_BOT_NAME = 40;
export const MAX_BOT_DESCRIPTION = 2_000;

// ── daemon → client ──────────────────────────────────────────────────────────────

export type ServerFrame =
  /** `serverId` names this daemon's data and survives restarts. A different one means the client's entries are from elsewhere. */
  | { readonly t: "welcome"; readonly serverId: string; readonly protocol: typeof PROTOCOL_VERSION }
  /** Every bot, once per connection. */
  | { readonly t: "bots"; readonly bots: readonly BotSummary[] }
  /** One bot's summary changed, or a new bot was made. */
  | { readonly t: "bot"; readonly bot: BotSummary }
  /** A bot was deleted, with its transcript. */
  | { readonly t: "botRemoved"; readonly bot: BotId }
  /** Every MCP server, once per connection. */
  | { readonly t: "mcpServers"; readonly servers: readonly McpServerView[] }
  /** One MCP server was added or changed (its settings, bots, state or tools). */
  | { readonly t: "mcpServer"; readonly server: McpServerView }
  | { readonly t: "mcpServerRemoved"; readonly id: McpServerId }
  /**
   * The answer to `watch`: the entries the client is missing (ascending). When more were missing than
   * fit, the newest ones and a `gap`. `earlier`: older entries exist before the first one sent (only
   * when the client sent no `after`).
   */
  | { readonly t: "sync"; readonly bot: BotId; readonly entries: readonly Entry[]; readonly gap?: Gap; readonly earlier?: boolean; readonly inbox: readonly QueuedMessage[] }
  /** A new entry of a watched bot. */
  | { readonly t: "entry"; readonly entry: Entry }
  /** A watched bot's queue changed. */
  | { readonly t: "inbox"; readonly bot: BotId; readonly items: readonly QueuedMessage[] }
  | { readonly t: "result"; readonly req: number; readonly ok: true; readonly value: unknown }
  | { readonly t: "result"; readonly req: number; readonly ok: false; readonly error: string }
  | { readonly t: "pong"; readonly at: number };
