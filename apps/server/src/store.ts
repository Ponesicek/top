/**
 * The daemon's one SQLite file, through Effect SQL (see sqlite.ts). Every write is a transaction with
 * `synchronous=FULL`, so once its Effect has run, the data survives a kill -9 or a power cut. That is
 * the whole durability story:
 *
 * - `entries`: every finished message of every bot (system, user, assistant, tool result) plus
 *   notices, numbered by one global sequence. Never updated or deleted.
 * - `inbox`: messages accepted from clients and not yet given to the model. Moving one into
 *   `entries` is a single transaction, so a message is never lost or doubled.
 * - `tool_calls`: written right before a tool runs, so after a crash the daemon knows whether a tool
 *   call without a result had started (it may have taken effect) or not.
 * - `bots`: the roster, plus whether a task was running and how often the daemon restarted during it.
 *   A deleted bot is first marked `deleted` (it may still be winding down a step), then purged with
 *   everything it wrote; a restart purges any that were only marked.
 * - `files`: the last listing of each bot's files folder, so changes made while the daemon was down are
 *   still reported when it starts. A `files` entry and the listing it reports change together.
 * - `mcp_servers`: MCP connections set up in the app, with their secrets and OAuth credentials, and
 *   `bot_mcp`: which bots use which. A bot has none until it is given one.
 * - `wakes`: wake-ups a bot set for itself (see wakes.ts). Firing one puts its message in the inbox in
 *   the same transaction, so a wake-up arrives once, also across restarts.
 * - `jobs`: tool calls that outran the time limit and went on in the background (see jobs.ts). Ending
 *   one puts its result in the inbox in the same transaction.
 * - `attachments`: files the user uploaded (see attachments.ts, which keeps the bytes on disk). One with
 *   no `bot` is waiting for a message to claim it; claiming it is part of accepting the message.
 *
 * Inbox rows and the entries they become carry a `source` when they don't come from the user, and the
 * user's attachments.
 *
 * The schema is built by numbered migrations (`MIGRATIONS`). A failing query is a broken disk or a bug,
 * not something a caller can handle, so the store's Effects die on it instead of failing.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { type Attachment, Attachment as AttachmentSchema, type MessageSource } from "@top/protocol";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

export type EntryKind = "system" | "user" | "assistant" | "tool" | "notice" | "files";

/** A file in a bot's files folder, as last seen. */
export type FileStat = { readonly size: number; readonly mtime: number };

export type StoredEntry = {
  readonly seq: number;
  readonly bot: number;
  readonly kind: EntryKind;
  /** JSON: an agent message (system/user/assistant/toolResult), `{ text }` for a notice, `{ files }` for files. */
  readonly message: string;
  readonly requestId: string | null;
  readonly toolCallId: string | null;
  readonly outcome: string | null;
  readonly source: MessageSource | null;
  readonly at: number;
};

export type BotRow = {
  readonly id: number;
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly model: string;
  readonly runActive: boolean;
  readonly restarts: number;
};

export type InboxRow = {
  readonly id: number;
  readonly bot: number;
  readonly requestId: string;
  readonly text: string;
  readonly mode: "steer" | "followUp";
  readonly clientId: string | null;
  readonly source: MessageSource | null;
  readonly attachments: readonly Attachment[];
  readonly at: number;
};

/** An uploaded file: `bot` is null until a message claims it. */
export type AttachmentRow = Attachment & { readonly bot: number | null; readonly at: number };

export type WakeRow = { readonly id: number; readonly bot: number; readonly dueAt: number; readonly note: string; readonly createdAt: number };

export type JobState = "running" | "finished" | "stopped" | "lost";
export type JobRow = {
  readonly id: number;
  readonly bot: number;
  readonly tool: string;
  /** The arguments, shortened to one line. */
  readonly summary: string;
  /** What it's for, in the bot's words; may be empty. */
  readonly note: string;
  readonly startedAt: number;
  readonly state: JobState;
};

export type McpServerRow = {
  readonly id: number;
  readonly name: string;
  /** JSON: the protocol's `McpServerConfig`, secret values included. */
  readonly config: string;
  /** JSON: pi-mcp's `McpOAuthState`, once the server signed in with OAuth. */
  readonly oauth: string | null;
};

export type ToolCallRow = { readonly name: string; readonly args: string; readonly startedAt: number; readonly finishedAt: number | null };

export type AppendExtra = {
  readonly requestId?: string | undefined;
  readonly toolCallId?: string | undefined;
  readonly outcome?: string | undefined;
  readonly source?: MessageSource | null | undefined;
  readonly at?: number | undefined;
};

// ── schema ───────────────────────────────────────────────────────────────────────

/** Tables as the first release made them, before migrations were numbered; `IF NOT EXISTS` so it fits those files too. */
const INITIAL_TABLES = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bots (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL,
  model TEXT NOT NULL,
  run_active INTEGER NOT NULL DEFAULT 0,
  restarts INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS entries (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  bot INTEGER NOT NULL REFERENCES bots(id),
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  request_id TEXT,
  tool_call_id TEXT,
  outcome TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS entries_by_bot ON entries(bot, seq);
CREATE UNIQUE INDEX IF NOT EXISTS entries_by_request ON entries(request_id) WHERE request_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS inbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot INTEGER NOT NULL REFERENCES bots(id),
  request_id TEXT NOT NULL UNIQUE,
  text TEXT NOT NULL,
  mode TEXT NOT NULL,
  client_id TEXT,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  bot INTEGER,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS attachments_by_bot ON attachments(bot);
CREATE TABLE IF NOT EXISTS tool_calls (
  assistant_seq INTEGER NOT NULL,
  tool_call_id TEXT NOT NULL,
  bot INTEGER NOT NULL,
  name TEXT NOT NULL,
  args TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  PRIMARY KEY (assistant_seq, tool_call_id)
);
CREATE TABLE IF NOT EXISTS files (
  bot INTEGER NOT NULL REFERENCES bots(id),
  path TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime REAL NOT NULL,
  PRIMARY KEY (bot, path)
);
CREATE TABLE IF NOT EXISTS mcp_servers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  config TEXT NOT NULL,
  oauth TEXT
);
CREATE TABLE IF NOT EXISTS bot_mcp (
  bot INTEGER NOT NULL REFERENCES bots(id),
  server INTEGER NOT NULL REFERENCES mcp_servers(id),
  PRIMARY KEY (bot, server)
);
CREATE TABLE IF NOT EXISTS wakes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot INTEGER NOT NULL REFERENCES bots(id),
  key TEXT NOT NULL UNIQUE,
  due_at INTEGER NOT NULL,
  note TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending'
);
CREATE INDEX IF NOT EXISTS wakes_due ON wakes(state, due_at);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot INTEGER NOT NULL REFERENCES bots(id),
  key TEXT NOT NULL UNIQUE,
  tool TEXT NOT NULL,
  summary TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  started_at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'running',
  finished_at INTEGER
)`;

/** Add a column unless the table has it (files from before migrations may have some of them). */
const addColumn = (table: string, column: string, definition: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const columns = yield* sql.unsafe<{ name: string }>(`PRAGMA table_info(${table})`);
    if (!columns.some((c) => c.name === column)) yield* sql.unsafe(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  });

/** Numbered migrations, run once each in order. Add new ones at the end; never change one that shipped. */
const MIGRATIONS: Record<string, Effect.Effect<void, SqlError, SqlClient.SqlClient>> = {
  "1_initial": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const statement of INITIAL_TABLES.split(";\n")) yield* sql.unsafe(statement);
    // Columns added in releases before migrations were numbered.
    yield* addColumn("bots", "description", "TEXT NOT NULL DEFAULT ''");
    yield* addColumn("bots", "deleted", "INTEGER NOT NULL DEFAULT 0");
    yield* addColumn("bots", "files_scanned", "INTEGER NOT NULL DEFAULT 0");
    yield* addColumn("inbox", "source", "TEXT");
    yield* addColumn("entries", "source", "TEXT");
    yield* addColumn("inbox", "attachments", "TEXT");
    yield* addColumn("jobs", "note", "TEXT NOT NULL DEFAULT ''");
  }),
};

// ── rows ─────────────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

const nullableString = (value: unknown) => (value === null || value === undefined ? null : String(value));

const entryOf = (row: Row): StoredEntry => ({
  seq: Number(row.seq),
  bot: Number(row.bot),
  kind: row.kind as EntryKind,
  message: String(row.message),
  requestId: nullableString(row.request_id),
  toolCallId: nullableString(row.tool_call_id),
  outcome: nullableString(row.outcome),
  source: nullableString(row.source) as MessageSource | null,
  at: Number(row.at),
});

const decodeAttachments = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(AttachmentSchema)));

const inboxOf = (row: Row): InboxRow => ({
  id: Number(row.id),
  bot: Number(row.bot),
  requestId: String(row.request_id),
  text: String(row.text),
  mode: row.mode === "steer" ? "steer" : "followUp",
  clientId: nullableString(row.client_id),
  source: nullableString(row.source) as MessageSource | null,
  attachments: row.attachments ? decodeAttachments(String(row.attachments)) : [],
  at: Number(row.at),
});

const attachmentOf = (row: Row): AttachmentRow => ({
  id: String(row.id),
  bot: row.bot === null ? null : Number(row.bot),
  name: String(row.name),
  mimeType: String(row.mime),
  size: Number(row.size),
  at: Number(row.at),
});

const wakeOf = (row: Row): WakeRow => ({
  id: Number(row.id),
  bot: Number(row.bot),
  dueAt: Number(row.due_at),
  note: String(row.note),
  createdAt: Number(row.created_at),
});

const jobOf = (row: Row): JobRow => ({
  id: Number(row.id),
  bot: Number(row.bot),
  tool: String(row.tool),
  summary: String(row.summary),
  note: String(row.note ?? ""),
  startedAt: Number(row.started_at),
  state: row.state as JobState,
});

const mcpServerOf = (row: Row): McpServerRow => ({ id: Number(row.id), name: String(row.name), config: String(row.config), oauth: nullableString(row.oauth) });

const botOf = (row: Row): BotRow => ({
  id: Number(row.id),
  name: String(row.name),
  description: String(row.description ?? ""),
  instructions: String(row.instructions),
  model: String(row.model),
  runActive: Number(row.run_active) === 1,
  restarts: Number(row.restarts),
});

// ── the service ──────────────────────────────────────────────────────────────────

export class Store extends Context.Service<
  Store,
  {
    /** Names this data, for clients: made once, kept across restarts. */
    readonly id: string;
    /** Part of every file link (see the protocol's FileView): made once, so links keep working across restarts. */
    readonly filesSecret: string;
    /** Run `effect` as one transaction (`BEGIN IMMEDIATE`); a failure rolls it back. */
    readonly transaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;

    // bots
    /** The bots that aren't deleted. */
    readonly bots: Effect.Effect<BotRow[]>;
    /** One bot, also while it is being deleted. */
    readonly bot: (id: number) => Effect.Effect<BotRow | undefined>;
    readonly createBot: (name: string, instructions: string, model: string, description?: string) => Effect.Effect<number>;
    /**
     * First half of deleting a bot: it leaves the roster, its queue is dropped and its name is free for a
     * new bot, but its rows stay so a step it is finishing can still be written. `purgeBot` removes them.
     */
    readonly markDeleted: (bot: number) => Effect.Effect<void>;
    /** Remove a bot and everything it wrote. */
    readonly purgeBot: (bot: number) => Effect.Effect<void>;
    /** A flag kept in the meta table (e.g. that the first bots were made, so deleting them all doesn't bring them back). */
    readonly flag: (key: string) => Effect.Effect<boolean>;
    readonly setFlag: (key: string) => Effect.Effect<void>;
    readonly setRunActive: (bot: number, active: boolean) => Effect.Effect<void>;
    readonly setRestarts: (bot: number, restarts: number) => Effect.Effect<void>;
    /** `provider/model-id`. Takes effect when the daemon next starts. */
    readonly setModel: (bot: number, model: string) => Effect.Effect<void>;

    // files
    /** The bot's files as last recorded; `undefined` before its folder was first looked at. */
    readonly files: (bot: number) => Effect.Effect<Map<string, FileStat> | undefined>;
    /**
     * Record the bot's files as they are now and, when `changes` has any, the `files` entry that reports
     * them, in one transaction: a crash can't report a change twice or lose one.
     */
    readonly recordFiles: (
      bot: number,
      listing: ReadonlyMap<string, FileStat>,
      changes: readonly { path: string; change: string }[],
    ) => Effect.Effect<StoredEntry | undefined>;

    // MCP servers
    readonly mcpServers: Effect.Effect<McpServerRow[]>;
    readonly mcpServer: (id: number) => Effect.Effect<McpServerRow | undefined>;
    readonly createMcpServer: (name: string, config: string) => Effect.Effect<number>;
    /** Change a server's name and settings. `resetOAuth` drops its credentials (they were for another URL). */
    readonly updateMcpServer: (id: number, name: string, config: string, resetOAuth: boolean) => Effect.Effect<void>;
    readonly setMcpOAuth: (id: number, oauth: string | null) => Effect.Effect<void>;
    readonly deleteMcpServer: (id: number) => Effect.Effect<void>;
    /** The bots (not deleted) that use each server: server id → bot ids. */
    readonly mcpAssignments: Effect.Effect<Map<number, number[]>>;
    readonly assignMcp: (server: number, bot: number, on: boolean) => Effect.Effect<void>;

    // entries
    readonly append: (bot: number, kind: EntryKind, message: unknown, extra?: AppendExtra) => Effect.Effect<StoredEntry>;
    readonly entry: (seq: number) => Effect.Effect<StoredEntry | undefined>;
    /** Every message the model sees, in order. */
    readonly context: (bot: number) => Effect.Effect<{ kind: EntryKind; message: unknown }[]>;
    /** The newest entry that is part of the model's context. */
    readonly lastContextEntry: (bot: number) => Effect.Effect<StoredEntry | undefined>;
    readonly lastSeq: (bot: number) => Effect.Effect<number>;
    readonly lastAssistantSeq: (bot: number) => Effect.Effect<number>;
    readonly lastAnswer: (bot: number) => Effect.Effect<unknown>;
    /** The newest `limit` visible entries, ascending. */
    readonly newest: (bot: number, limit: number) => Effect.Effect<StoredEntry[]>;
    /** Up to `limit` visible entries after `after`, ascending. */
    readonly after: (bot: number, after: number, limit: number) => Effect.Effect<StoredEntry[]>;
    readonly hasBefore: (bot: number, seq: number) => Effect.Effect<boolean>;
    /** Visible entries with after < seq < before, the newest `limit` of them, ascending; `more` if older ones remain. */
    readonly history: (bot: number, before: number, after: number, limit: number) => Effect.Effect<{ entries: StoredEntry[]; more: boolean }>;
    /** Tool call IDs that already have a result after the given entry. */
    readonly toolResultsAfter: (bot: number, seq: number) => Effect.Effect<Set<string>>;

    // inbox
    /** Queue a message from a client; its attachments become the bot's in the same transaction. A `requestId` seen before changes nothing. */
    readonly submit: (
      bot: number,
      requestId: string,
      text: string,
      mode: "steer" | "followUp",
      clientId: string | null,
      attachments?: readonly Attachment[],
    ) => Effect.Effect<"queued" | "duplicate">;
    readonly inbox: (bot: number) => Effect.Effect<InboxRow[]>;
    readonly inboxRow: (requestId: string) => Effect.Effect<InboxRow | undefined>;
    /** The model took a queued message: it becomes an entry and leaves the inbox, atomically. */
    readonly place: (bot: number, requestId: string, message: unknown) => Effect.Effect<StoredEntry>;

    // attachments
    readonly addAttachment: (attachment: Attachment) => Effect.Effect<void>;
    readonly attachment: (id: string) => Effect.Effect<AttachmentRow | undefined>;
    /** Uploads no message claimed, made before `before`. */
    readonly unclaimedAttachments: (before: number) => Effect.Effect<AttachmentRow[]>;
    /** A bot's attachments (to delete their files with the bot). */
    readonly botAttachments: (bot: number) => Effect.Effect<AttachmentRow[]>;
    readonly deleteAttachment: (id: string) => Effect.Effect<void>;

    // wake-ups
    /** Set a wake-up. `key` names the tool call that set it: setting it again returns the same one. */
    readonly addWake: (bot: number, key: string, dueAt: number, note: string) => Effect.Effect<WakeRow>;
    /** A bot's wake-ups that haven't gone off, soonest first. */
    readonly wakes: (bot: number) => Effect.Effect<WakeRow[]>;
    /** False if the bot has no such wake-up waiting. */
    readonly cancelWake: (bot: number, id: number) => Effect.Effect<boolean>;
    /** When the next wake-up of any bot is due. */
    readonly nextWakeAt: Effect.Effect<number | undefined>;
    readonly dueWakes: (now: number) => Effect.Effect<WakeRow[]>;
    /** Mark a wake-up as gone off and queue its message, atomically; `undefined` if it already went off or was cancelled. */
    readonly fireWake: (wake: WakeRow, text: string) => Effect.Effect<InboxRow | undefined>;

    // background jobs
    /** Record a tool call that went on in the background. `key` is the call's: the same call twice is one job. */
    readonly startJob: (bot: number, key: string, tool: string, summary: string, note: string, startedAt: number) => Effect.Effect<number>;
    readonly job: (id: number) => Effect.Effect<JobRow | undefined>;
    /** Jobs still marked running: at startup, the ones the last process was running when it stopped. */
    readonly runningJobs: Effect.Effect<JobRow[]>;
    /**
     * End a running job and, with `text`, queue the message that reports it, atomically. `undefined`
     * (and nothing queued) if it wasn't running: already ended, or its bot was deleted.
     */
    readonly endJob: (id: number, state: Exclude<JobState, "running">, text?: string) => Effect.Effect<InboxRow | undefined>;

    // tool calls
    readonly toolStarted: (bot: number, assistantSeq: number, toolCallId: string, name: string, args: unknown) => Effect.Effect<void>;
    /** A tool's result and the end of its call record, atomically. */
    readonly toolFinished: (bot: number, assistantSeq: number, toolCallId: string, message: unknown, outcome?: string) => Effect.Effect<StoredEntry>;
    readonly toolCall: (assistantSeq: number, toolCallId: string) => Effect.Effect<ToolCallRow | undefined>;
  }
>()("top/Store") {}

const VISIBLE = "kind != 'system'";
/** Entries the model sees: not the ones only clients show. */
const CONTEXT = "kind NOT IN ('notice', 'files')";

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Durable before a write returns; foreign keys checked. Outside any transaction, as SQLite requires.
  yield* sql`PRAGMA synchronous = FULL`;
  yield* sql`PRAGMA foreign_keys = ON`;
  yield* Migrator.make({})({ loader: Migrator.fromRecord(MIGRATIONS) });

  // A failed query is a broken disk or a bug: nothing a caller could do about it.
  const q = <A>(effect: Effect.Effect<A, SqlError>): Effect.Effect<A> => Effect.orDie(effect);
  const rows = (effect: Effect.Effect<ReadonlyArray<Row>, SqlError>) => q(effect);
  const first = (effect: Effect.Effect<ReadonlyArray<Row>, SqlError>) => Effect.map(q(effect), (r) => r[0]);
  const now = Clock.currentTimeMillis;
  const transaction = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    sql.withTransaction(effect).pipe(Effect.catchTag("SqlError", (error) => Effect.die(error))) as Effect.Effect<A, E, R>;

  const meta = (key: string, initial: string) =>
    Effect.gen(function* () {
      yield* q(sql`INSERT OR IGNORE INTO meta (key, value) VALUES (${key}, ${initial})`);
      return String((yield* first(sql`SELECT value FROM meta WHERE key = ${key}`))?.value);
    });
  const id = yield* meta("id", randomUUID());
  const filesSecret = yield* meta("files_secret", randomBytes(18).toString("base64url"));

  const append = Effect.fnUntraced(function* (bot: number, kind: EntryKind, message: unknown, extra: AppendExtra = {}) {
    const at = extra.at ?? (yield* now);
    const json = JSON.stringify(message);
    const requestId = extra.requestId ?? null;
    const toolCallId = extra.toolCallId ?? null;
    const outcome = extra.outcome ?? null;
    const source = extra.source ?? null;
    const row = yield* first(sql`
      INSERT INTO entries (bot, kind, message, request_id, tool_call_id, outcome, source, at)
      VALUES (${bot}, ${kind}, ${json}, ${requestId}, ${toolCallId}, ${outcome}, ${source}, ${at})
      RETURNING seq`);
    return { seq: Number(row!.seq), bot, kind, message: json, requestId, toolCallId, outcome, source, at } satisfies StoredEntry;
  });

  const inboxRow = (requestId: string) => Effect.map(first(sql`SELECT * FROM inbox WHERE request_id = ${requestId}`), (row) => row && inboxOf(row));

  /** A message from Top itself (not the user), queued for the bot. Inside a transaction. */
  const queueEvent = Effect.fnUntraced(function* (bot: number, requestId: string, text: string, source: MessageSource) {
    // Steered: mid-task it reaches the bot at its next step, not only when the task would end.
    yield* q(sql`
      INSERT INTO inbox (bot, request_id, text, mode, client_id, source, attachments, at)
      VALUES (${bot}, ${requestId}, ${text}, 'steer', NULL, ${source}, NULL, ${yield* now})`);
    return (yield* inboxRow(requestId))!;
  });

  const purgeBot = (bot: number) =>
    transaction(
      Effect.gen(function* () {
        for (const table of ["entries", "inbox", "tool_calls", "bot_mcp", "files", "wakes", "jobs", "attachments"])
          yield* q(sql.unsafe(`DELETE FROM ${table} WHERE bot = ?`, [bot]));
        yield* q(sql`DELETE FROM bots WHERE id = ${bot}`);
      }),
    );

  // Bots deleted just before a crash or a stop: finish the job.
  for (const row of yield* rows(sql`SELECT id FROM bots WHERE deleted = 1`)) yield* purgeBot(Number(row.id));

  return Store.of({
    id,
    filesSecret,
    transaction,

    bots: Effect.map(rows(sql`SELECT * FROM bots WHERE deleted = 0 ORDER BY id`), (r) => r.map(botOf)),
    bot: (bot) => Effect.map(first(sql`SELECT * FROM bots WHERE id = ${bot}`), (row) => row && botOf(row)),
    createBot: (name, instructions, model, description = "") =>
      Effect.map(
        first(sql`INSERT INTO bots (name, description, instructions, model) VALUES (${name}, ${description}, ${instructions}, ${model}) RETURNING id`),
        (row) => Number(row!.id),
      ),
    markDeleted: (bot) =>
      transaction(
        Effect.gen(function* () {
          yield* q(sql`UPDATE bots SET deleted = 1, run_active = 0, name = ${`deleted:${bot}:${randomUUID()}`} WHERE id = ${bot}`);
          yield* q(sql`DELETE FROM inbox WHERE bot = ${bot}`);
          yield* q(sql`DELETE FROM bot_mcp WHERE bot = ${bot}`);
          yield* q(sql`UPDATE wakes SET state = 'cancelled' WHERE bot = ${bot} AND state = 'pending'`);
          yield* q(sql`UPDATE jobs SET state = 'stopped' WHERE bot = ${bot} AND state = 'running'`);
        }),
      ),
    purgeBot,
    flag: (key) => Effect.map(first(sql`SELECT 1 AS one FROM meta WHERE key = ${`flag:${key}`}`), (row) => row !== undefined),
    setFlag: (key) => Effect.asVoid(q(sql`INSERT OR IGNORE INTO meta (key, value) VALUES (${`flag:${key}`}, '1')`)),
    setRunActive: (bot, active) => Effect.asVoid(q(sql`UPDATE bots SET run_active = ${active ? 1 : 0} WHERE id = ${bot}`)),
    setRestarts: (bot, restarts) => Effect.asVoid(q(sql`UPDATE bots SET restarts = ${restarts} WHERE id = ${bot}`)),
    setModel: (bot, model) => Effect.asVoid(q(sql`UPDATE bots SET model = ${model} WHERE id = ${bot}`)),

    files: (bot) =>
      Effect.gen(function* () {
        const scanned = yield* first(sql`SELECT files_scanned FROM bots WHERE id = ${bot}`);
        if (!scanned || Number(scanned.files_scanned) !== 1) return undefined;
        const files = yield* rows(sql`SELECT path, size, mtime FROM files WHERE bot = ${bot}`);
        return new Map(files.map((row) => [String(row.path), { size: Number(row.size), mtime: Number(row.mtime) }]));
      }),
    recordFiles: (bot, listing, changes) =>
      transaction(
        Effect.gen(function* () {
          yield* q(sql`DELETE FROM files WHERE bot = ${bot}`);
          for (const [path, stat] of listing) yield* q(sql`INSERT INTO files (bot, path, size, mtime) VALUES (${bot}, ${path}, ${stat.size}, ${stat.mtime})`);
          yield* q(sql`UPDATE bots SET files_scanned = 1 WHERE id = ${bot}`);
          return changes.length ? yield* append(bot, "files", { files: changes }) : undefined;
        }),
      ),

    mcpServers: Effect.map(rows(sql`SELECT * FROM mcp_servers ORDER BY id`), (r) => r.map(mcpServerOf)),
    mcpServer: (server) => Effect.map(first(sql`SELECT * FROM mcp_servers WHERE id = ${server}`), (row) => row && mcpServerOf(row)),
    createMcpServer: (name, config) =>
      Effect.map(first(sql`INSERT INTO mcp_servers (name, config) VALUES (${name}, ${config}) RETURNING id`), (row) => Number(row!.id)),
    updateMcpServer: (server, name, config, resetOAuth) =>
      Effect.asVoid(
        q(
          resetOAuth
            ? sql`UPDATE mcp_servers SET name = ${name}, config = ${config}, oauth = NULL WHERE id = ${server}`
            : sql`UPDATE mcp_servers SET name = ${name}, config = ${config} WHERE id = ${server}`,
        ),
      ),
    setMcpOAuth: (server, oauth) => Effect.asVoid(q(sql`UPDATE mcp_servers SET oauth = ${oauth} WHERE id = ${server}`)),
    deleteMcpServer: (server) =>
      transaction(
        Effect.gen(function* () {
          yield* q(sql`DELETE FROM bot_mcp WHERE server = ${server}`);
          yield* q(sql`DELETE FROM mcp_servers WHERE id = ${server}`);
        }),
      ),
    mcpAssignments: Effect.map(
      rows(sql`SELECT bot, server FROM bot_mcp JOIN bots ON bots.id = bot_mcp.bot WHERE bots.deleted = 0 ORDER BY bot`),
      (assignments) => {
        const map = new Map<number, number[]>();
        for (const row of assignments) {
          const server = Number(row.server);
          map.set(server, [...(map.get(server) ?? []), Number(row.bot)]);
        }
        return map;
      },
    ),
    assignMcp: (server, bot, on) =>
      Effect.asVoid(
        q(
          on ? sql`INSERT OR IGNORE INTO bot_mcp (bot, server) VALUES (${bot}, ${server})` : sql`DELETE FROM bot_mcp WHERE bot = ${bot} AND server = ${server}`,
        ),
      ),

    append,
    entry: (seq) => Effect.map(first(sql`SELECT * FROM entries WHERE seq = ${seq}`), (row) => row && entryOf(row)),
    context: (bot) =>
      Effect.map(rows(sql.unsafe(`SELECT kind, message FROM entries WHERE bot = ? AND ${CONTEXT} ORDER BY seq`, [bot])), (r) =>
        r.map((row) => ({ kind: row.kind as EntryKind, message: JSON.parse(String(row.message)) as unknown })),
      ),
    lastContextEntry: (bot) =>
      Effect.map(first(sql.unsafe(`SELECT * FROM entries WHERE bot = ? AND ${CONTEXT} ORDER BY seq DESC LIMIT 1`, [bot])), (row) => row && entryOf(row)),
    lastSeq: (bot) => Effect.map(first(sql.unsafe(`SELECT MAX(seq) AS seq FROM entries WHERE bot = ? AND ${VISIBLE}`, [bot])), (row) => Number(row?.seq ?? 0)),
    lastAssistantSeq: (bot) =>
      Effect.map(first(sql`SELECT MAX(seq) AS seq FROM entries WHERE bot = ${bot} AND kind = 'assistant'`), (row) => Number(row?.seq ?? 0)),
    lastAnswer: (bot) =>
      Effect.map(first(sql`SELECT message FROM entries WHERE bot = ${bot} AND kind = 'assistant' ORDER BY seq DESC LIMIT 1`), (row) =>
        row ? (JSON.parse(String(row.message)) as unknown) : undefined,
      ),
    newest: (bot, limit) =>
      Effect.map(rows(sql.unsafe(`SELECT * FROM entries WHERE bot = ? AND ${VISIBLE} ORDER BY seq DESC LIMIT ?`, [bot, limit])), (r) =>
        r.map(entryOf).reverse(),
      ),
    after: (bot, after, limit) =>
      Effect.map(rows(sql.unsafe(`SELECT * FROM entries WHERE bot = ? AND ${VISIBLE} AND seq > ? ORDER BY seq LIMIT ?`, [bot, after, limit])), (r) =>
        r.map(entryOf),
      ),
    hasBefore: (bot, seq) =>
      Effect.map(
        first(sql.unsafe(`SELECT EXISTS(SELECT 1 FROM entries WHERE bot = ? AND ${VISIBLE} AND seq < ?) AS any`, [bot, seq])),
        (row) => Number(row?.any) === 1,
      ),
    history: (bot, before, after, limit) =>
      Effect.map(
        rows(
          sql.unsafe(`SELECT * FROM entries WHERE bot = ? AND ${VISIBLE} AND seq < ? AND seq > ? ORDER BY seq DESC LIMIT ?`, [bot, before, after, limit + 1]),
        ),
        (r) => {
          const entries = r.map(entryOf);
          return { entries: entries.slice(0, limit).reverse(), more: entries.length > limit };
        },
      ),
    toolResultsAfter: (bot, seq) =>
      Effect.map(
        rows(sql`SELECT tool_call_id FROM entries WHERE bot = ${bot} AND kind = 'tool' AND seq > ${seq}`),
        (r) => new Set(r.map((row) => String(row.tool_call_id))),
      ),

    submit: (bot, requestId, text, mode, clientId, attachments = []) =>
      transaction(
        Effect.gen(function* () {
          const known =
            (yield* first(sql`SELECT 1 AS one FROM entries WHERE request_id = ${requestId}`)) ??
            (yield* first(sql`SELECT 1 AS one FROM inbox WHERE request_id = ${requestId}`));
          if (known) return "duplicate" as const;
          const json = attachments.length ? JSON.stringify(attachments) : null;
          yield* q(sql`
            INSERT INTO inbox (bot, request_id, text, mode, client_id, source, attachments, at)
            VALUES (${bot}, ${requestId}, ${text}, ${mode}, ${clientId}, NULL, ${json}, ${yield* now})`);
          for (const attachment of attachments) yield* q(sql`UPDATE attachments SET bot = ${bot} WHERE id = ${attachment.id}`);
          return "queued" as const;
        }),
      ),
    inbox: (bot) => Effect.map(rows(sql`SELECT * FROM inbox WHERE bot = ${bot} ORDER BY id`), (r) => r.map(inboxOf)),
    inboxRow,
    place: (bot, requestId, message) =>
      transaction(
        Effect.gen(function* () {
          const source = (yield* inboxRow(requestId))?.source ?? null;
          yield* q(sql`DELETE FROM inbox WHERE request_id = ${requestId}`);
          return yield* append(bot, "user", message, { requestId, source });
        }),
      ),

    addAttachment: (attachment) =>
      Effect.gen(function* () {
        yield* q(sql`
          INSERT INTO attachments (id, bot, name, mime, size, at)
          VALUES (${attachment.id}, NULL, ${attachment.name}, ${attachment.mimeType}, ${attachment.size}, ${yield* now})`);
      }),
    attachment: (attachment) => Effect.map(first(sql`SELECT * FROM attachments WHERE id = ${attachment}`), (row) => row && attachmentOf(row)),
    unclaimedAttachments: (before) => Effect.map(rows(sql`SELECT * FROM attachments WHERE bot IS NULL AND at < ${before}`), (r) => r.map(attachmentOf)),
    botAttachments: (bot) => Effect.map(rows(sql`SELECT * FROM attachments WHERE bot = ${bot}`), (r) => r.map(attachmentOf)),
    deleteAttachment: (attachment) => Effect.asVoid(q(sql`DELETE FROM attachments WHERE id = ${attachment}`)),

    addWake: (bot, key, dueAt, note) =>
      Effect.gen(function* () {
        yield* q(sql`INSERT OR IGNORE INTO wakes (bot, key, due_at, note, created_at) VALUES (${bot}, ${key}, ${dueAt}, ${note}, ${yield* now})`);
        return wakeOf((yield* first(sql`SELECT * FROM wakes WHERE key = ${key}`))!);
      }),
    wakes: (bot) => Effect.map(rows(sql`SELECT * FROM wakes WHERE bot = ${bot} AND state = 'pending' ORDER BY due_at, id`), (r) => r.map(wakeOf)),
    cancelWake: (bot, wake) =>
      Effect.map(rows(sql`UPDATE wakes SET state = 'cancelled' WHERE id = ${wake} AND bot = ${bot} AND state = 'pending' RETURNING id`), (r) => r.length > 0),
    nextWakeAt: Effect.map(first(sql`SELECT MIN(due_at) AS due FROM wakes WHERE state = 'pending'`), (row) =>
      row?.due === null || row?.due === undefined ? undefined : Number(row.due),
    ),
    dueWakes: (at) => Effect.map(rows(sql`SELECT * FROM wakes WHERE state = 'pending' AND due_at <= ${at} ORDER BY due_at, id`), (r) => r.map(wakeOf)),
    fireWake: (wake, text) =>
      transaction(
        Effect.gen(function* () {
          const fired = yield* rows(sql`UPDATE wakes SET state = 'fired' WHERE id = ${wake.id} AND state = 'pending' RETURNING id`);
          return fired.length ? yield* queueEvent(wake.bot, `wake:${wake.id}`, text, "wake") : undefined;
        }),
      ),

    startJob: (bot, key, tool, summary, note, startedAt) =>
      Effect.map(
        first(sql`
          INSERT INTO jobs (bot, key, tool, summary, note, started_at) VALUES (${bot}, ${key}, ${tool}, ${summary}, ${note}, ${startedAt})
          ON CONFLICT(key) DO UPDATE SET state = 'running', started_at = excluded.started_at, finished_at = NULL
          RETURNING id`),
        (row) => Number(row!.id),
      ),
    job: (job) => Effect.map(first(sql`SELECT * FROM jobs WHERE id = ${job}`), (row) => row && jobOf(row)),
    runningJobs: Effect.map(rows(sql`SELECT * FROM jobs WHERE state = 'running' ORDER BY id`), (r) => r.map(jobOf)),
    endJob: (job, state, text) =>
      transaction(
        Effect.gen(function* () {
          const at = yield* now;
          const row = yield* first(sql`UPDATE jobs SET state = ${state}, finished_at = ${at} WHERE id = ${job} AND state = 'running' RETURNING bot`);
          if (!row || text === undefined) return undefined;
          return yield* queueEvent(Number(row.bot), `job:${job}:${at}`, text, "job");
        }),
      ),

    toolStarted: (bot, assistantSeq, toolCallId, name, args) =>
      Effect.gen(function* () {
        yield* q(sql`
          INSERT OR IGNORE INTO tool_calls (assistant_seq, tool_call_id, bot, name, args, started_at)
          VALUES (${assistantSeq}, ${toolCallId}, ${bot}, ${name}, ${JSON.stringify(args ?? {})}, ${yield* now})`);
      }),
    toolFinished: (bot, assistantSeq, toolCallId, message, outcome) =>
      transaction(
        Effect.gen(function* () {
          yield* q(sql`UPDATE tool_calls SET finished_at = ${yield* now} WHERE assistant_seq = ${assistantSeq} AND tool_call_id = ${toolCallId}`);
          return yield* append(bot, "tool", message, { toolCallId, outcome });
        }),
      ),
    toolCall: (assistantSeq, toolCallId) =>
      Effect.map(first(sql`SELECT * FROM tool_calls WHERE assistant_seq = ${assistantSeq} AND tool_call_id = ${toolCallId}`), (row) =>
        row
          ? {
              name: String(row.name),
              args: String(row.args),
              startedAt: Number(row.started_at),
              finishedAt: row.finished_at === null ? null : Number(row.finished_at),
            }
          : undefined,
      ),
  });
});

/** The store on the `SqlClient` it's given. */
export const layer: Layer.Layer<Store, SqlError | Migrator.MigrationError, SqlClient.SqlClient> = Layer.effect(Store, make);
