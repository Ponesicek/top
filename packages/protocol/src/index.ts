/**
 * Top's wire protocol: JSON frames over one WebSocket (compressed with permessage-deflate) between
 * the Top daemon and its clients.
 *
 * Nothing streams. A bot's transcript is a list of finished, immutable entries, each with a sequence
 * number from one counter shared by all bots. A client says which entries it already has (`after`),
 * gets only the ones it is missing, then each new entry once. The sidebar gets one small summary per
 * bot that changed.
 *
 * Every frame is a TypeBox schema and its type is derived from it, so what the code assumes is what
 * `parseClientFrame` / `parseServerFrame` check when a frame arrives. The schemas check shape only;
 * limits with a message for the user (name lengths, …) are checked where the frame is handled.
 */
import Type, { type Static, type TAddReadonly, type TObject, type TProperties, type TSchema } from "typebox";
import { Compile } from "typebox/compile";

export const PROTOCOL_VERSION = 3;
export const DEFAULT_PORT = 7357;

// ── schema helpers ───────────────────────────────────────────────────────────────

type TStruct<P extends TProperties> = TObject<{ [K in keyof P]: TAddReadonly<P[K]> }>;

/** An object whose properties are all readonly. Unknown properties are allowed, so a newer peer can add some. */
function Struct<const P extends TProperties>(properties: P): TStruct<P> {
  return Type.Object(Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, Type.Readonly(value)]))) as never;
}

/** A readonly array. */
const List = <T extends TSchema>(item: T) => Type.Immutable(Type.Array(item));
const Optional = Type.Optional;

// ── bots and entries ─────────────────────────────────────────────────────────────

export const BotId = Type.Integer();
export type BotId = Static<typeof BotId>;
/** Global, strictly increasing entry number. Entries of one bot are increasing but not contiguous. */
export const Seq = Type.Integer();
export type Seq = Static<typeof Seq>;

export const BotStatus = Type.Enum([
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
export type BotStatus = Static<typeof BotStatus>;

export const BotSummary = Struct({
  id: BotId,
  name: Type.String(),
  /** What the bot is for, as given when it was made. Empty when none was given. */
  description: Type.String(),
  status: BotStatus,
  /** The running tool's name while `status` is `tool`. */
  tool: Optional(Type.String()),
  /** When the current status began (ms since epoch), for an elapsed timer. */
  since: Type.Number(),
  /** The failure or retry reason, when there is one. */
  error: Optional(Type.String()),
  /** The last line of the bot's latest answer, for the sidebar. */
  preview: Type.String(),
  /** Messages waiting behind the running task. */
  queued: Type.Integer(),
  /** Newest entry of this bot, so a client can show "unread" without loading it. */
  lastSeq: Seq,
});
export type BotSummary = Static<typeof BotSummary>;

export const ToolCallView = Struct({
  id: Type.String(),
  name: Type.String(),
  /** The arguments, shortened to one line. */
  summary: Type.String(),
});
export type ToolCallView = Static<typeof ToolCallView>;

/**
 * What happened to a tool call that was cut off by a daemon restart:
 * - `interrupted`: it may or may not have taken effect, and was not run again.
 * - `not_run`: the daemon stopped before the tool started.
 * - `recovered`: the tool checked its own outcome after the restart.
 * - `replayed`: the tool is safe to repeat, so it ran again.
 * - `stopped`: it kept crashing the daemon, so the task was ended.
 */
export const ToolOutcome = Type.Enum(["interrupted", "not_run", "recovered", "replayed", "stopped"]);
export type ToolOutcome = Static<typeof ToolOutcome>;

const entryBase = { seq: Seq, bot: BotId, at: Type.Number() };

export const Entry = Type.Union([
  Struct({ ...entryBase, kind: Type.Literal("user"), text: Type.String(), requestId: Optional(Type.String()) }),
  Struct({
    ...entryBase,
    kind: Type.Literal("assistant"),
    text: Type.String(),
    tools: Optional(List(ToolCallView)),
    /** Thinking text exists; fetch it with `detail`. */
    hasThinking: Optional(Type.Literal(true)),
    /** Full thinking text, only in a `detail` answer. */
    thinking: Optional(Type.String()),
    error: Optional(Type.String()),
    stopped: Optional(Type.Literal(true)),
  }),
  Struct({
    ...entryBase,
    kind: Type.Literal("tool"),
    toolCallId: Type.String(),
    name: Type.String(),
    /** The result text, shortened unless this came from `detail`. */
    text: Type.String(),
    truncated: Optional(Type.Literal(true)),
    isError: Optional(Type.Literal(true)),
    outcome: Optional(ToolOutcome),
  }),
  Struct({ ...entryBase, kind: Type.Literal("notice"), text: Type.String() }),
  /** Files in the bot's files folder were added, changed or removed (by the bot or anyone else). Not part of the model's context. */
  Struct({ ...entryBase, kind: Type.Literal("files"), files: List(Struct({ path: Type.String(), change: Type.Enum(["added", "changed", "removed"]) })) }),
]);
export type Entry = Static<typeof Entry>;
export type FileChange = Extract<Entry, { kind: "files" }>["files"][number];

export const WhenBusy = Type.Enum(["steer", "followUp", "reject"]);
export type WhenBusy = Static<typeof WhenBusy>;

export const QueuedMessage = Struct({
  requestId: Type.String(),
  text: Type.String(),
  mode: Type.Enum(["steer", "followUp"]),
  at: Type.Number(),
});
export type QueuedMessage = Static<typeof QueuedMessage>;

/** Entries strictly between `after` and `before` exist on the daemon but were not sent. */
export const Gap = Struct({ after: Seq, before: Seq });
export type Gap = Static<typeof Gap>;

// ── files ────────────────────────────────────────────────────────────────────────
//
// Each bot has a files folder: what it makes for the user (pages, reports, images). The daemon watches
// it, sends its listing to the clients watching the bot, and serves the files over HTTP on its own
// port at `<filesPath>/<bot>/<path>` (`filesPath` is in `welcome`; it holds a secret, so a web page
// can't guess it). Clients render them or hand the link or the path to other tools.

/** One file in a bot's files folder. `path` is relative to the folder, with `/` between parts. */
export const FileView = Struct({ path: Type.String(), size: Type.Integer(), mtime: Type.Number() });
export type FileView = Static<typeof FileView>;

/** The most files a listing holds; a folder with more says `more`. */
export const MAX_FILES = 1_000;

// ── MCP servers ──────────────────────────────────────────────────────────────────
//
// MCP servers are set up once on the daemon and then assigned to bots; a bot has none until it is
// given one. Each is its own connection with its own credentials, so the same URL can be added twice
// (two accounts). Every bot it's assigned to shares that one connection.

export const McpServerId = Type.Integer();
export type McpServerId = Static<typeof McpServerId>;

/**
 * An environment variable (stdio) or HTTP header whose value may be a secret. The daemon never sends
 * values back: in a view `value` is absent. When saving, an absent `value` keeps the stored one.
 */
export const McpSecret = Struct({ name: Type.String(), value: Optional(Type.String()) });
export type McpSecret = Static<typeof McpSecret>;

export const McpServerConfig = Type.Union([
  /** A local program the daemon starts, speaking MCP over stdin/stdout. */
  Struct({ transport: Type.Literal("stdio"), command: Type.String(), args: List(Type.String()), env: List(McpSecret) }),
  /** A remote server over Streamable HTTP. Without an `Authorization` header, it signs in with OAuth if it asks. */
  Struct({ transport: Type.Literal("http"), url: Type.String(), headers: List(McpSecret) }),
]);
export type McpServerConfig = Static<typeof McpServerConfig>;

export const McpServerState = Type.Enum([
  /** Starting the program or reaching the server. */
  "connecting",
  /** Connected; its tools are offered to the bots it's assigned to. */
  "ready",
  /** The server wants the user to sign in (OAuth) before it can be used. */
  "signin",
  /** It couldn't be started or reached (`error` says why); it is retried now and then. */
  "failed",
]);
export type McpServerState = Static<typeof McpServerState>;

export const McpServerView = Struct({
  id: McpServerId,
  name: Type.String(),
  /** Secret values are left out. */
  config: McpServerConfig,
  /** The bots that have this server's tools. */
  bots: List(BotId),
  state: McpServerState,
  error: Optional(Type.String()),
  /** The server's tool names, while it is connected. */
  tools: List(Type.String()),
  /** It holds OAuth credentials (an account is signed in). */
  signedIn: Optional(Type.Literal(true)),
});
export type McpServerView = Static<typeof McpServerView>;

/** The longest MCP server name `saveMcpServer` accepts. */
export const MAX_MCP_NAME = 40;

// ── client → daemon ──────────────────────────────────────────────────────────────

const req = Type.Integer();

export const ClientFrame = Type.Union([
  /**
   * `serverId`: the daemon the client's entries came from (from an earlier `welcome`, or its cache).
   * If it isn't this daemon, the `after` of this connection's watches is ignored and the newest entries
   * are sent instead: those sequence numbers belong to another daemon's data.
   */
  Struct({
    t: Type.Literal("hello"),
    clientId: Type.String(),
    protocol: Type.Literal(PROTOCOL_VERSION),
    serverId: Optional(Type.String()),
  }),
  /** Follow a bot. `after`: the newest entry the client holds; omit it to get the newest `limit`. */
  Struct({ t: Type.Literal("watch"), bot: BotId, after: Optional(Seq), limit: Optional(Type.Integer()) }),
  Struct({ t: Type.Literal("unwatch"), bot: BotId }),
  /** Entries older than `before` (and newer than `after`, if given), newest first up to `limit`. */
  Struct({ t: Type.Literal("history"), req, bot: BotId, before: Seq, after: Optional(Seq), limit: Type.Integer() }),
  /** One entry in full: untruncated tool output, thinking, tool arguments. */
  Struct({ t: Type.Literal("detail"), req, bot: BotId, seq: Seq }),
  Struct({
    t: Type.Literal("submit"),
    req,
    bot: BotId,
    /** Idempotency key: a resend after a drop is applied once. */
    requestId: Type.String(),
    text: Type.String(),
    whenBusy: WhenBusy,
    clientId: Type.String(),
  }),
  Struct({ t: Type.Literal("abort"), req, bot: BotId }),
  /** Make a bot. Answers with its id; every client gets its summary in a `bot` frame first. */
  Struct({ t: Type.Literal("createBot"), req, name: Type.String(), description: Type.String() }),
  /** Delete a bot and its whole transcript. Every client gets `botRemoved`. */
  Struct({ t: Type.Literal("deleteBot"), req, bot: BotId }),
  /** Add an MCP server (no `id`) or change one. Answers with its id; every client gets an `mcpServer` frame. */
  Struct({
    t: Type.Literal("saveMcpServer"),
    req,
    id: Optional(McpServerId),
    name: Type.String(),
    config: McpServerConfig,
  }),
  /** Remove an MCP server: its bots lose its tools, and its credentials are erased. */
  Struct({ t: Type.Literal("deleteMcpServer"), req, id: McpServerId }),
  /** Give a bot an MCP server's tools (`on`), or take them away. They change from the bot's next message. */
  Struct({ t: Type.Literal("assignMcp"), req, server: McpServerId, bot: BotId, on: Type.Boolean() }),
  /** Start signing in to an MCP server. Answers with the page to open in a browser on the daemon's computer. */
  Struct({ t: Type.Literal("mcpSignIn"), req, id: McpServerId }),
  /** Forget an MCP server's credentials, to sign in again (as another account). */
  Struct({ t: Type.Literal("mcpSignOut"), req, id: McpServerId }),
  /** Reconnect to an MCP server now instead of waiting for the next retry. */
  Struct({ t: Type.Literal("mcpRetry"), req, id: McpServerId }),
  Struct({ t: Type.Literal("ping"), at: Type.Number() }),
]);
export type ClientFrame = Static<typeof ClientFrame>;

export type HistoryResult = {
  readonly entries: readonly Entry[] /** More entries remain in the asked range. */;
  readonly more: boolean;
};
export type SubmitResult = { readonly duplicate: boolean };
export type CreateBotResult = { readonly id: BotId };
export type SaveMcpServerResult = { readonly id: McpServerId };
export type McpSignInResult = { readonly url: string };

/** The longest bot name and description `createBot` accepts. */
export const MAX_BOT_NAME = 40;
export const MAX_BOT_DESCRIPTION = 2_000;

// ── daemon → client ──────────────────────────────────────────────────────────────

export const ServerFrame = Type.Union([
  /** `serverId` names this daemon's data and survives restarts. A different one means the client's entries are from elsewhere. */
  Struct({
    t: Type.Literal("welcome"),
    serverId: Type.String(),
    protocol: Type.Literal(PROTOCOL_VERSION),
    /** Where the bots' files are served on this daemon's address, e.g. `/files/<secret>` (see FileView). */
    filesPath: Optional(Type.String()),
  }),
  /** Every bot, once per connection. */
  Struct({ t: Type.Literal("bots"), bots: List(BotSummary) }),
  /** One bot's summary changed, or a new bot was made. */
  Struct({ t: Type.Literal("bot"), bot: BotSummary }),
  /** A bot was deleted, with its transcript. */
  Struct({ t: Type.Literal("botRemoved"), bot: BotId }),
  /** Every MCP server, once per connection. */
  Struct({ t: Type.Literal("mcpServers"), servers: List(McpServerView) }),
  /** One MCP server was added or changed (its settings, bots, state or tools). */
  Struct({ t: Type.Literal("mcpServer"), server: McpServerView }),
  Struct({ t: Type.Literal("mcpServerRemoved"), id: McpServerId }),
  /**
   * The answer to `watch`: the entries the client is missing (ascending). When more were missing than
   * fit, the newest ones and a `gap`. `earlier`: older entries exist before the first one sent (only
   * when the client sent no `after`).
   */
  Struct({
    t: Type.Literal("sync"),
    bot: BotId,
    entries: List(Entry),
    gap: Optional(Gap),
    earlier: Optional(Type.Boolean()),
    inbox: List(QueuedMessage),
  }),
  /** A new entry of a watched bot. */
  Struct({ t: Type.Literal("entry"), entry: Entry }),
  /**
   * A watched bot's files: once after its `sync`, then whenever they change. `folder` is the folder's
   * absolute path on the daemon's computer. `more`: there were more than `MAX_FILES`; the rest are left out.
   */
  Struct({ t: Type.Literal("files"), bot: BotId, folder: Type.String(), files: List(FileView), more: Optional(Type.Literal(true)) }),
  /** A watched bot's queue changed. */
  Struct({ t: Type.Literal("inbox"), bot: BotId, items: List(QueuedMessage) }),
  Struct({ t: Type.Literal("result"), req, ok: Type.Literal(true), value: Type.Unknown() }),
  Struct({ t: Type.Literal("result"), req, ok: Type.Literal(false), error: Type.String() }),
  Struct({ t: Type.Literal("pong"), at: Type.Number() }),
]);
export type ServerFrame = Static<typeof ServerFrame>;

// ── checking what arrives ────────────────────────────────────────────────────────

export type Parsed<T> =
  | { readonly ok: true; readonly frame: T }
  /** `req`: the frame's request number, when it had one, so the sender can be told. */
  | { readonly ok: false; readonly error: string; readonly req?: number };

/**
 * A parser for a union of frames tagged by `t`. It picks the variant(s) by `t` first, so an error names
 * the field that's wrong instead of "matches none of 16 frames", and only that variant is checked.
 */
function frameParser<T>(union: { anyOf: readonly TSchema[] }): (text: string) => Parsed<T> {
  const byTag = new Map<string, ReturnType<typeof Compile>[]>();
  for (const variant of union.anyOf) {
    const tag = String((variant as { properties: { t: { const: string } } }).properties.t.const);
    byTag.set(tag, [...(byTag.get(tag) ?? []), Compile(variant)]);
  }
  return (text) => {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return { ok: false, error: "Not JSON" };
    }
    const record = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
    const req = Number.isInteger(record.req) ? (record.req as number) : undefined;
    const fail = (error: string): Parsed<T> => ({ ok: false, error, ...(req === undefined ? {} : { req }) });
    const variants = byTag.get(String(record.t));
    if (!variants) return fail(`Unknown frame ${JSON.stringify(record.t)}`);
    for (const variant of variants) if (variant.Check(value)) return { ok: true, frame: value as T };
    const [error] = variants[0]!.Errors(value);
    return fail(`Bad ${String(record.t)} frame: ${error ? `${error.instancePath || "/"} ${error.message}` : "invalid"}`);
  };
}

/** Parse and check a frame from a client. */
export const parseClientFrame = frameParser<ClientFrame>(ClientFrame);
/** Parse and check a frame from the daemon. */
export const parseServerFrame = frameParser<ServerFrame>(ServerFrame);

const validators = new WeakMap<TSchema, ReturnType<typeof Compile>>();

/** Check a value read back from storage or elsewhere; throws with the first problem. */
export function check<T extends TSchema>(schema: T, value: unknown, what: string): Static<T> {
  let validator = validators.get(schema);
  if (!validator) {
    validator = Compile(schema);
    validators.set(schema, validator);
  }
  if (validator.Check(value)) return value as Static<T>;
  const [error] = validator.Errors(value);
  throw new Error(`Bad ${what}: ${error ? `${error.instancePath || "/"} ${error.message}` : "invalid"}`);
}
