/**
 * Top's wire protocol: JSON frames over one WebSocket (compressed with permessage-deflate) between
 * the Top daemon and its clients.
 *
 * Nothing streams. A bot's transcript is a list of finished, immutable entries, each with a sequence
 * number from one counter shared by all bots. A client says which entries it already has (`after`),
 * gets only the ones it is missing, then each new entry once. The sidebar gets one small summary per
 * bot that changed.
 *
 * Every frame is an Effect Schema and its type is derived from it, so what the code assumes is what
 * `parseClientFrame` / `parseServerFrame` check when a frame arrives. The schemas check shape only;
 * limits with a message for the user (name lengths, …) are checked where the frame is handled.
 */
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import { CHANNELS } from "./release.ts";

export * from "./errors.ts";
export * from "./release.ts";

export const PROTOCOL_VERSION = 4;
export const DEFAULT_PORT = 7357;

// ── schema helpers ───────────────────────────────────────────────────────────────
//
// Struct properties and arrays are readonly. Unknown properties are ignored, so a newer peer can add some.

const Struct = Schema.Struct;
const List = Schema.Array;
/** A property that may be absent (never present as `undefined`). */
const Optional = Schema.optionalKey;

// ── bots and entries ─────────────────────────────────────────────────────────────

export const BotId = Schema.Int;
export type BotId = typeof BotId.Type;
/** Global, strictly increasing entry number. Entries of one bot are increasing but not contiguous. */
export const Seq = Schema.Int;
export type Seq = typeof Seq.Type;

export const BotStatus = Schema.Literals([
  /** Nothing running. */
  "idle",
  /** Waiting on the model. */
  "thinking",
  /** Running a tool (`tool` names it). */
  "tool",
  /** The model request failed; retrying after a backoff. */
  "retrying",
  /** The last run ended in an error it could not recover from. */
  "failed",
]);
export type BotStatus = typeof BotStatus.Type;

export const BotSummary = Struct({
  id: BotId,
  name: Schema.String,
  /** What the bot is for, as given when it was made. Empty when none was given. */
  description: Schema.String,
  /**
   * Which of the drawings for its name the bot wears (see `createBot`). Absent for the first one, the
   * drawing of the name alone, which is every bot made before this could be picked.
   */
  avatar: Optional(Schema.Int),
  status: BotStatus,
  /** The running tool's name while `status` is `tool`. */
  tool: Optional(Schema.String),
  /** When the current status began (ms since epoch), for an elapsed timer. */
  since: Schema.Number,
  /** The failure or retry reason, when there is one. */
  error: Optional(Schema.String),
  /** The last line of the bot's latest answer, for the sidebar. */
  preview: Schema.String,
  /** Messages waiting behind the running task. */
  queued: Schema.Int,
  /** Tool calls that outran the time limit and are still running in the background. */
  background: Optional(Schema.Int),
  /** Permission requests waiting for the user's answer (see PermissionRequest). */
  approvals: Optional(Schema.Int),
  /** When the bot's next wake-up is due (ms since epoch), if it set one. */
  wakeAt: Optional(Schema.Number),
  /** Newest entry of this bot, so a client can show "unread" without loading it. */
  lastSeq: Seq,
});
export type BotSummary = typeof BotSummary.Type;

export const ToolCallView = Struct({
  id: Schema.String,
  name: Schema.String,
  /** The arguments, shortened to one line. */
  summary: Schema.String,
});
export type ToolCallView = typeof ToolCallView.Type;

/**
 * What happened to a tool call that was cut off by a daemon restart:
 * - `interrupted`: it may or may not have taken effect, and was not run again.
 * - `not_run`: the daemon stopped before the tool started.
 * - `recovered`: the tool checked its own outcome after the restart.
 * - `replayed`: the tool is safe to repeat, so it ran again.
 * - `stopped`: it kept crashing the daemon, so the task was ended.
 */
export const ToolOutcome = Schema.Literals(["interrupted", "not_run", "recovered", "replayed", "stopped"]);
export type ToolOutcome = typeof ToolOutcome.Type;

// ── attachments ──────────────────────────────────────────────────────────────────
//
// Files the user sends with a message. A client uploads each one over HTTP as soon as it's attached
// (`POST <attachmentsPath>/upload?name=<name>`, the raw bytes as the body, `Content-Type` its type) and
// gets its `Attachment` back; `submit` then names the attachments by id. They are served at
// `<attachmentsPath>/<id>` (`attachmentsPath` is in `welcome`, and holds a secret like `filesPath`).
// An upload no message claims is deleted after a day; a sent one lives as long as its bot.
//
// The bot gets every attachment's path on the daemon's computer, to open with its tools, and images it
// can see (`isModelImage`) as images too.

/** `mimeType` is what the daemon decided the file is: an image whose bytes aren't that image is `application/octet-stream`. */
export const Attachment = Struct({ id: Schema.String, name: Schema.String, mimeType: Schema.String, size: Schema.Int });
export type Attachment = typeof Attachment.Type;

/** The most attachments one message takes. */
export const MAX_ATTACHMENTS = 20;
/** The largest file the daemon accepts. */
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
/** The largest image a model is given as an image; a larger one goes as a file (its path only). */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/**
 * Images are shrunk to this many pixels on their long side before upload. Anthropic refuses larger
 * ones once a request holds more than 20 images, which would break every later request of the bot.
 */
export const MAX_IMAGE_EDGE = 2000;
/** The image types models take as images. Others (SVG, HEIC, BMP, …) are files. */
export const MODEL_IMAGE_TYPES: readonly string[] = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/** Whether the bot sees an attachment as an image (besides getting its path). */
export const isModelImage = (attachment: Pick<Attachment, "mimeType" | "size">) =>
  MODEL_IMAGE_TYPES.includes(attachment.mimeType) && attachment.size <= MAX_IMAGE_BYTES;

// ── permission requests ──────────────────────────────────────────────────────────
//
// A bot can ask the user whether it may do something (Collar's `ask_permission`). Asking doesn't make
// the bot wait: the call's result says it asked, and the bot carries on. The request waits on the
// daemon, also across restarts, until a client answers it or the user stops the bot (which withdraws
// it). The first answer wins; any later one is refused. What came of it is a `permission` entry naming
// the request, and an answer also reaches the bot once, as a message. This only carries the question
// and the answer: it doesn't stop a bot's other tools from running.

/** What a bot asked permission for: on the tool entry of the call that asked, and in the waiting list. */
export const PermissionAsk = Struct({
  /** Names this one request; never reused. */
  id: Schema.Int,
  /** What the bot wants to do, in its words. */
  action: Schema.String,
  /** Why, in its words, when it said. */
  reason: Optional(Schema.String),
});
export type PermissionAsk = typeof PermissionAsk.Type;

/** A request waiting for the user's answer. */
export const PermissionRequest = Struct({ ...PermissionAsk.fields, bot: BotId });
export type PermissionRequest = typeof PermissionRequest.Type;

/** What came of a request: the user's answer, or `withdrawn` by the user's Stop before they answered. */
export const PermissionAnswer = Schema.Literals(["allowed", "denied", "withdrawn"]);
export type PermissionAnswer = typeof PermissionAnswer.Type;

/** The longest action and reason a bot may ask with. */
export const MAX_PERMISSION_ACTION = 500;
export const MAX_PERMISSION_REASON = 1_000;

const entryBase = { seq: Seq, bot: BotId, at: Schema.Number };

/** A file in a bot's files folder that was added, changed or removed. */
export const FileChange = Struct({ path: Schema.String, change: Schema.Literals(["added", "changed", "removed"]) });
export type FileChange = typeof FileChange.Type;

/**
 * Who a message in the bot's inbox comes from, when it isn't the user:
 * - `wake`: a wake-up the bot set for itself came due;
 * - `job`: a tool call that ran on in the background finished (or was cut off);
 * - `permission`: the user answered one of the bot's permission requests (see PermissionRequest).
 * The model reads it like any message; clients show it as an event, not as something the user said.
 */
export const MessageSource = Schema.Literals(["wake", "job", "permission"]);
export type MessageSource = typeof MessageSource.Type;

export const Entry = Schema.Union([
  Struct({
    ...entryBase,
    kind: Schema.Literal("user"),
    text: Schema.String,
    attachments: Optional(List(Attachment)),
    requestId: Optional(Schema.String),
    source: Optional(MessageSource),
  }),
  Struct({
    ...entryBase,
    kind: Schema.Literal("assistant"),
    text: Schema.String,
    tools: Optional(List(ToolCallView)),
    /** Thinking text exists; fetch it with `detail`. */
    hasThinking: Optional(Schema.Literal(true)),
    /** Full thinking text, only in a `detail` answer. */
    thinking: Optional(Schema.String),
    error: Optional(Schema.String),
    stopped: Optional(Schema.Literal(true)),
  }),
  Struct({
    ...entryBase,
    kind: Schema.Literal("tool"),
    toolCallId: Schema.String,
    name: Schema.String,
    /** The result text, shortened unless this came from `detail`. */
    text: Schema.String,
    truncated: Optional(Schema.Literal(true)),
    isError: Optional(Schema.Literal(true)),
    outcome: Optional(ToolOutcome),
    /** The call asked the user's permission: this request. Its answer is a `permission` entry naming it. */
    permission: Optional(PermissionAsk),
  }),
  /** The user answered a permission request, or it was withdrawn (see PermissionRequest). Not part of the model's context. */
  Struct({ ...entryBase, kind: Schema.Literal("permission"), request: Schema.Int, answer: PermissionAnswer }),
  Struct({ ...entryBase, kind: Schema.Literal("notice"), text: Schema.String }),
  /** Files in the bot's files folder were added, changed or removed (by the bot or anyone else). Not part of the model's context. */
  Struct({
    ...entryBase,
    kind: Schema.Literal("files"),
    files: List(FileChange),
  }),
]);
export type Entry = typeof Entry.Type;

export const WhenBusy = Schema.Literals(["steer", "followUp", "reject"]);
export type WhenBusy = typeof WhenBusy.Type;

export const QueuedMessage = Struct({
  requestId: Schema.String,
  text: Schema.String,
  attachments: Optional(List(Attachment)),
  mode: Schema.Literals(["steer", "followUp"]),
  at: Schema.Number,
  source: Optional(MessageSource),
});
export type QueuedMessage = typeof QueuedMessage.Type;

/** Entries strictly between `after` and `before` exist on the daemon but were not sent. */
export const Gap = Struct({ after: Seq, before: Seq });
export type Gap = typeof Gap.Type;

// ── files ────────────────────────────────────────────────────────────────────────
//
// Each bot has a files folder: what it makes for the user (pages, reports, images). The daemon watches
// it, sends its listing to the clients watching the bot, and serves the files over HTTP on its own
// port at `<filesPath>/<bot>/<path>` (`filesPath` is in `welcome`; it holds a secret, so a web page
// can't guess it). Clients render them or hand the link or the path to other tools.

/** One file in a bot's files folder. `path` is relative to the folder, with `/` between parts. */
export const FileView = Struct({ path: Schema.String, size: Schema.Int, mtime: Schema.Number });
export type FileView = typeof FileView.Type;

/** The most files a listing holds; a folder with more says `more`. */
export const MAX_FILES = 1_000;

// ── Tailscale ────────────────────────────────────────────────────────────────────
//
// With `--tailscale`, the daemon is also on the user's tailnet (`tailnetUrl` in `welcome`), and lets in
// its devices (or only those `--tailscale-allow` names). A client that came in that way is told who
// Tailscale says it is.

/** Who a client is, by Tailscale: its device, and the person who owns it (a tagged device has tags instead). */
export const Viewer = Struct({
  device: Schema.String,
  login: Optional(Schema.String),
  name: Optional(Schema.String),
  tags: Optional(List(Schema.String)),
});
export type Viewer = typeof Viewer.Type;

// ── MCP servers ──────────────────────────────────────────────────────────────────
//
// MCP servers are set up once on the daemon and then assigned to bots; a bot has none until it is
// given one. Each is its own connection with its own credentials, so the same URL can be added twice
// (two accounts). Every bot it's assigned to shares that one connection.

export const McpServerId = Schema.Int;
export type McpServerId = typeof McpServerId.Type;

/**
 * An environment variable (stdio) or HTTP header whose value may be a secret. The daemon never sends
 * values back: in a view `value` is absent. When saving, an absent `value` keeps the stored one.
 */
export const McpSecret = Struct({ name: Schema.String, value: Optional(Schema.String) });
export type McpSecret = typeof McpSecret.Type;

export const McpServerConfig = Schema.Union([
  /** A local program the daemon starts, speaking MCP over stdin/stdout. */
  Struct({ transport: Schema.Literal("stdio"), command: Schema.String, args: List(Schema.String), env: List(McpSecret) }),
  /** A remote server over Streamable HTTP. Without an `Authorization` header, it signs in with OAuth if it asks. */
  Struct({ transport: Schema.Literal("http"), url: Schema.String, headers: List(McpSecret) }),
]);
export type McpServerConfig = typeof McpServerConfig.Type;

export const McpServerState = Schema.Literals([
  /** Starting the program or reaching the server. */
  "connecting",
  /** Connected; its tools are offered to the bots it's assigned to. */
  "ready",
  /** The server wants the user to sign in (OAuth) before it can be used. */
  "signin",
  /** It couldn't be started or reached (`error` says why); it is retried now and then. */
  "failed",
]);
export type McpServerState = typeof McpServerState.Type;

export const McpServerView = Struct({
  id: McpServerId,
  name: Schema.String,
  /** Secret values are left out. */
  config: McpServerConfig,
  /** The bots that have this server's tools. */
  bots: List(BotId),
  state: McpServerState,
  error: Optional(Schema.String),
  /** The server's tool names, while it is connected. */
  tools: List(Schema.String),
  /** It holds OAuth credentials (an account is signed in). */
  signedIn: Optional(Schema.Literal(true)),
});
export type McpServerView = typeof McpServerView.Type;

/** The longest MCP server name `saveMcpServer` accepts. */
export const MAX_MCP_NAME = 40;

// ── the model account ────────────────────────────────────────────────────────────
//
// What the bots' model requests are signed in with. With an OpenAI model, the user can sign in with
// ChatGPT from the app and the bots use their ChatGPT plan. `chatgptSignIn` answers with the page to
// open. When the user approves, the browser goes to `http://127.0.0.1:1455/auth/callback?…` on the
// computer it runs on. On the daemon's own computer, the daemon is listening there and the sign-in
// finishes by itself. Anywhere else, that page fails to load, and the user pastes its address into the
// app (`chatgptSignInFinish`).

/** The address a ChatGPT sign-in ends on, which the user pastes when it can't reach the daemon. */
export const CHATGPT_REDIRECT = "http://127.0.0.1:1455/auth/callback";
/** Where the user sees and limits what apps use of their ChatGPT plan. */
export const CHATGPT_USAGE_URL = "https://chatgpt.com/settings/usage";
/** What the user agrees to before signing in (the app and `top login` both show it). */
export const CHATGPT_BACKGROUND_NOTICE =
  "Your bots work on their own: they wake up when they set themselves to and finish background jobs, also while no app is open. Signed in with ChatGPT, that uses your ChatGPT plan too, within its usage limits. You can see and limit it in ChatGPT's settings.";

export const AccountView = Struct({
  /** The bots' model, `provider/model-id`. */
  model: Schema.String,
  /** How model requests are signed in: with the user's ChatGPT plan, or an API key (stored, or in the daemon's environment). Absent: they aren't. */
  signedIn: Optional(Schema.Literals(["chatgpt", "apiKey"])),
  /** The model's provider takes Sign in with ChatGPT. */
  canSignIn: Schema.Boolean,
  /** A sign-in is under way; this is the page it opened. */
  signingIn: Optional(Schema.String),
  /** Why the last sign-in failed. */
  error: Optional(Schema.String),
});
export type AccountView = typeof AccountView.Type;

// ── updates ──────────────────────────────────────────────────────────────────────

/** Which releases something follows (see release.ts). */
export const Channel = Schema.Literals(CHANNELS);
export type Channel = typeof Channel.Type;

/** A release newer than what runs. */
export const UpdateRelease = Struct({
  version: Schema.String,
  /** What changed: the commit subjects since the channel's previous release. */
  notes: List(Schema.String),
  /** The release's page on GitHub. */
  url: Schema.String,
});
export type UpdateRelease = typeof UpdateRelease.Type;

/**
 * The daemon's updates. `state`: `idle`, or what it's doing: `checking`, `downloading` the new version,
 * or `restarting` on it (the connection drops next). `failed`: the last check or install went wrong; `error` says what.
 */
export const UpdateView = Struct({
  channel: Channel,
  /** The version that runs. */
  current: Schema.String,
  state: Schema.Literals(["idle", "checking", "downloading", "restarting", "failed"]),
  /** The newest release on the channel, when it's newer than `current`. */
  available: Optional(UpdateRelease),
  /** When the daemon last heard from GitHub (ms since the epoch). */
  checkedAt: Optional(Schema.Number),
  error: Optional(Schema.String),
  /** A version that didn't start, so the daemon went back to `current`. */
  rolledBack: Optional(Schema.String),
});
export type UpdateView = typeof UpdateView.Type;

// ── client → daemon ──────────────────────────────────────────────────────────────

const req = Schema.Int;

export const ClientFrame = Schema.Union([
  /**
   * `serverId`: the daemon the client's entries came from (from an earlier `welcome`, or its cache).
   * If it isn't this daemon, the `after` of this connection's watches is ignored and the newest entries
   * are sent instead: those sequence numbers belong to another daemon's data.
   */
  Struct({
    t: Schema.Literal("hello"),
    clientId: Schema.String,
    /** The client's `PROTOCOL_VERSION`. Any number is accepted, so a daemon can tell an app that's too old or too new. */
    protocol: Schema.Int,
    serverId: Optional(Schema.String),
  }),
  /** Follow a bot. `after`: the newest entry the client holds; omit it to get the newest `limit`. */
  Struct({ t: Schema.Literal("watch"), bot: BotId, after: Optional(Seq), limit: Optional(Schema.Int) }),
  Struct({ t: Schema.Literal("unwatch"), bot: BotId }),
  /** Entries older than `before` (and newer than `after`, if given), newest first up to `limit`. */
  Struct({ t: Schema.Literal("history"), req, bot: BotId, before: Seq, after: Optional(Seq), limit: Schema.Int }),
  /** One entry in full: untruncated tool output, thinking, tool arguments. */
  Struct({ t: Schema.Literal("detail"), req, bot: BotId, seq: Seq }),
  Struct({
    t: Schema.Literal("submit"),
    req,
    bot: BotId,
    /** Idempotency key: a resend after a drop is applied once. */
    requestId: Schema.String,
    text: Schema.String,
    /** Uploaded attachments, by id (see Attachment). The text may be empty when there are some. */
    attachments: Optional(List(Schema.String)),
    whenBusy: WhenBusy,
    clientId: Schema.String,
  }),
  Struct({ t: Schema.Literal("abort"), req, bot: BotId }),
  /** Make a bot. Answers with its id; every client gets its summary in a `bot` frame first. */
  Struct({
    t: Schema.Literal("createBot"),
    req,
    name: Schema.String,
    description: Schema.String,
    /** Which drawing of the name to wear, 0 to `MAX_BOT_AVATAR` (see BotSummary). Absent means 0. */
    avatar: Optional(Schema.Int),
  }),
  /** Delete a bot and its whole transcript. Every client gets `botRemoved`. */
  Struct({ t: Schema.Literal("deleteBot"), req, bot: BotId }),
  /** Add an MCP server (no `id`) or change one. Answers with its id; every client gets an `mcpServer` frame. */
  Struct({
    t: Schema.Literal("saveMcpServer"),
    req,
    id: Optional(McpServerId),
    name: Schema.String,
    config: McpServerConfig,
  }),
  /** Remove an MCP server: its bots lose its tools, and its credentials are erased. */
  Struct({ t: Schema.Literal("deleteMcpServer"), req, id: McpServerId }),
  /** Give a bot an MCP server's tools (`on`), or take them away. They change from the bot's next message. */
  Struct({ t: Schema.Literal("assignMcp"), req, server: McpServerId, bot: BotId, on: Schema.Boolean }),
  /**
   * Start signing in to an MCP server. Answers with the page to open in a browser: on the daemon's
   * computer, or (when the daemon has a `tailnetUrl`) on any device it lets in.
   */
  Struct({ t: Schema.Literal("mcpSignIn"), req, id: McpServerId }),
  /** Forget an MCP server's credentials, to sign in again (as another account). */
  Struct({ t: Schema.Literal("mcpSignOut"), req, id: McpServerId }),
  /** Reconnect to an MCP server now instead of waiting for the next retry. */
  Struct({ t: Schema.Literal("mcpRetry"), req, id: McpServerId }),
  /**
   * Start signing in with ChatGPT (see AccountView), dropping any sign-in already under way. Answers
   * with the page to open. `backgroundConsent`: the user agreed that the bots may use their plan while
   * nobody is watching (wake-ups, background jobs). OpenAI's terms ask for that before background use.
   */
  Struct({ t: Schema.Literal("chatgptSignIn"), req, backgroundConsent: Schema.Literal(true) }),
  /** Finish the sign-in under way with the address the browser ended on. Answers once the daemon is signed in. */
  Struct({ t: Schema.Literal("chatgptSignInFinish"), req, url: Schema.String }),
  Struct({ t: Schema.Literal("chatgptSignInCancel"), req }),
  /** Forget the ChatGPT sign-in. */
  Struct({ t: Schema.Literal("chatgptSignOut"), req }),
  /** Look for a newer release on the daemon's channel now (it also looks every few hours). */
  Struct({ t: Schema.Literal("checkForUpdate"), req }),
  /** Update the daemon to `version`, the one its `update` frame offers. It restarts on the new version. */
  Struct({ t: Schema.Literal("installUpdate"), req, version: Schema.String }),
  /** Which releases the daemon follows from now on. It never goes back to an older version. */
  Struct({ t: Schema.Literal("setUpdateChannel"), req, channel: Channel }),
  /**
   * Answer a bot's permission request (see PermissionRequest). `bot` must be the bot that asked. Refused
   * with a `PermissionError` when it was answered already (on this device or another), or isn't waiting anymore.
   */
  Struct({ t: Schema.Literal("answerPermission"), req, id: Schema.Int, bot: BotId, allow: Schema.Boolean }),
  Struct({ t: Schema.Literal("ping"), at: Schema.Number }),
]);
export type ClientFrame = typeof ClientFrame.Type;

/** A frame that asks for an answer: a `result` frame with the same `req`. */
export type RequestFrame = Extract<ClientFrame, { readonly req: number }>;
export type RequestType = RequestFrame["t"];

/** What each request answers with: the `value` of its `result` frame. Requests that only do something answer `null`. */
export const RequestResult = {
  history: Struct({
    entries: List(Entry),
    /** More entries remain in the asked range. */
    more: Schema.Boolean,
  }),
  /** `null` for an entry clients don't see. */
  detail: Schema.NullOr(Entry),
  submit: Struct({ duplicate: Schema.Boolean }),
  abort: Schema.Null,
  createBot: Struct({ id: BotId }),
  deleteBot: Schema.Null,
  saveMcpServer: Struct({ id: McpServerId }),
  deleteMcpServer: Schema.Null,
  assignMcp: Schema.Null,
  mcpSignIn: Struct({ url: Schema.String }),
  mcpSignOut: Schema.Null,
  mcpRetry: Schema.Null,
  chatgptSignIn: Struct({ url: Schema.String }),
  chatgptSignInFinish: Schema.Null,
  chatgptSignInCancel: Schema.Null,
  chatgptSignOut: Schema.Null,
  checkForUpdate: Schema.Null,
  installUpdate: Schema.Null,
  setUpdateChannel: Schema.Null,
  answerPermission: Schema.Null,
} as const satisfies { readonly [T in RequestType]: Schema.Codec<unknown> };
export type ResultOf<T extends RequestType> = (typeof RequestResult)[T]["Type"];

export type HistoryResult = ResultOf<"history">;
export type SubmitResult = ResultOf<"submit">;
export type CreateBotResult = ResultOf<"createBot">;
export type SaveMcpServerResult = ResultOf<"saveMcpServer">;
export type McpSignInResult = ResultOf<"mcpSignIn">;

/** The longest bot name and description `createBot` accepts. */
export const MAX_BOT_NAME = 40;
export const MAX_BOT_DESCRIPTION = 2_000;
/** The highest avatar `createBot` accepts: plenty of drawings to pick from, and a number that stays short. */
export const MAX_BOT_AVATAR = 9_999;

// ── daemon → client ──────────────────────────────────────────────────────────────

export const ServerFrame = Schema.Union([
  /** `serverId` names this daemon's data and survives restarts. A different one means the client's entries are from elsewhere. */
  Struct({
    t: Schema.Literal("welcome"),
    serverId: Schema.String,
    /** The daemon's `PROTOCOL_VERSION`. A client with another one can't talk to it, and should say which side to update. */
    protocol: Schema.Int,
    /** The daemon's version, e.g. `0.2.0` or `0.2.0-nightly.20261114.7` (a checkout's ends in `-dev`). */
    version: Optional(Schema.String),
    /** The releases the daemon follows; absent on one run from a checkout. */
    channel: Optional(Channel),
    /** Where the bots' files are served on this daemon's address, e.g. `/files/<secret>` (see FileView). */
    filesPath: Optional(Schema.String),
    /** Where attachments are uploaded and served on this daemon's address, e.g. `/attachments/<secret>` (see Attachment). */
    attachmentsPath: Optional(Schema.String),
    /** Where the daemon is on the user's tailnet, e.g. `wss://box.tail1234.ts.net:7357` (with `--tailscale`). */
    tailnetUrl: Optional(Schema.String),
    /** Who this client is, when it connected over the tailnet. */
    viewer: Optional(Viewer),
  }),
  /** Every bot, once per connection. */
  Struct({ t: Schema.Literal("bots"), bots: List(BotSummary) }),
  /** One bot's summary changed, or a new bot was made. */
  Struct({ t: Schema.Literal("bot"), bot: BotSummary }),
  /** A bot was deleted, with its transcript. */
  Struct({ t: Schema.Literal("botRemoved"), bot: BotId }),
  /** Every MCP server, once per connection. */
  Struct({ t: Schema.Literal("mcpServers"), servers: List(McpServerView) }),
  /** One MCP server was added or changed (its settings, bots, state or tools). */
  Struct({ t: Schema.Literal("mcpServer"), server: McpServerView }),
  Struct({ t: Schema.Literal("mcpServerRemoved"), id: McpServerId }),
  /** What the bots' model requests are signed in with: once per connection (on a daemon with real bots), then whenever it changes. */
  Struct({ t: Schema.Literal("account"), account: AccountView }),
  /**
   * The answer to `watch`: the entries the client is missing (ascending). When more were missing than
   * fit, the newest ones and a `gap`. `earlier`: older entries exist before the first one sent (only
   * when the client sent no `after`).
   */
  Struct({
    t: Schema.Literal("sync"),
    bot: BotId,
    entries: List(Entry),
    gap: Optional(Gap),
    earlier: Optional(Schema.Boolean),
    inbox: List(QueuedMessage),
  }),
  /** A new entry of a watched bot. */
  Struct({ t: Schema.Literal("entry"), entry: Entry }),
  /**
   * A watched bot's files: once after its `sync`, then whenever they change. `folder` is the folder's
   * absolute path on the daemon's computer. `more`: there were more than `MAX_FILES`; the rest are left out.
   */
  Struct({ t: Schema.Literal("files"), bot: BotId, folder: Schema.String, files: List(FileView), more: Optional(Schema.Literal(true)) }),
  /** A watched bot's queue changed. */
  Struct({ t: Schema.Literal("inbox"), bot: BotId, items: List(QueuedMessage) }),
  /** Every permission request waiting for an answer, oldest first: once per connection, then whenever one comes or goes. */
  Struct({ t: Schema.Literal("permissions"), requests: List(PermissionRequest) }),
  /** The daemon's updates: once per connection on an installed daemon, then whenever they change. */
  Struct({ t: Schema.Literal("update"), update: UpdateView }),
  Struct({ t: Schema.Literal("result"), req, ok: Schema.Literal(true), value: Schema.Unknown }),
  Struct({ t: Schema.Literal("result"), req, ok: Schema.Literal(false), error: Schema.String }),
  Struct({ t: Schema.Literal("pong"), at: Schema.Number }),
]);
export type ServerFrame = typeof ServerFrame.Type;

// ── checking what arrives ────────────────────────────────────────────────────────

export type Parsed<T> =
  | { readonly ok: true; readonly frame: T }
  /** `req`: the frame's request number, when it had one, so the sender can be told. */
  | { readonly ok: false; readonly error: string; readonly req?: number };

const formatIssue = SchemaIssue.makeFormatterDefault();

/**
 * A parser for a union of frames tagged by `t`. It picks the variant(s) by `t` first, so an error names
 * the field that's wrong instead of "matches none of 16 frames", and only that variant is checked.
 */
/** A frame's schema: a struct whose `t` is a literal. */
type FrameSchema = Schema.Decoder<unknown> & { readonly fields: { readonly t: { readonly literal: string } } };

function frameParser<M extends FrameSchema>(union: { readonly members: ReadonlyArray<M> }): (text: string) => Parsed<M["Type"]> {
  const byTag = new Map<string, M[]>();
  for (const member of union.members) byTag.set(member.fields.t.literal, [...(byTag.get(member.fields.t.literal) ?? []), member]);
  const decoders = new Map(
    [...byTag].map(([tag, members]) => [
      tag,
      Schema.decodeUnknownResult<Schema.Decoder<M["Type"]>>(members.length === 1 ? members[0]! : Schema.Union(members)),
    ]),
  );
  return (text) => {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return { ok: false, error: "Not JSON" };
    }
    const object = typeof value === "object" && value !== null ? value : {};
    const t = "t" in object ? object.t : undefined;
    const req = "req" in object && typeof object.req === "number" && Number.isInteger(object.req) ? object.req : undefined;
    const fail = (error: string): Parsed<M["Type"]> => ({ ok: false, error, ...(req === undefined ? {} : { req }) });
    const decode = decoders.get(String(t));
    if (!decode) return fail(`Unknown frame ${JSON.stringify(t)}`);
    const result = decode(value);
    if (Result.isSuccess(result)) return { ok: true, frame: result.success };
    return fail(`Bad ${String(t)} frame: ${formatIssue(result.failure.issue)}`);
  };
}

/** Parse and check a frame from a client. */
export const parseClientFrame: (text: string) => Parsed<ClientFrame> = frameParser(ClientFrame);
/** Parse and check a frame from the daemon. */
export const parseServerFrame: (text: string) => Parsed<ServerFrame> = frameParser(ServerFrame);
