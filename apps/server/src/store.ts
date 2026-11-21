import { randomBytes, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import type { McpOAuthState } from "@earendil-works/pi-mcp/oauth";
import {
  Ask,
  type AskOutcome,
  type Attachment,
  Attachment as AttachmentSchema,
  type FileChange,
  McpServerConfig,
  MessageSource,
  type QuestionReply,
  ToolOutcome,
} from "@top/protocol";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { summaryMessage } from "./compaction.ts";
import {
  AnswerView,
  AssistantView,
  type Compaction,
  CompactionView,
  type EntryBody,
  FilesView,
  NoticeView,
  SystemView,
  ToolResultView,
  type TranscriptMessage,
  transcriptMessage,
  UserView,
} from "./messages.ts";
import { HARNESS_RUNS_TABLE, makeTaskQueries, TASK_PURGE_ORDER, TASK_TABLES, type TaskQueries } from "./tasks/store.ts";

const Int = Schema.Int;
const Text = Schema.String;
const NullableText = Schema.NullOr(Schema.String);
const Source = Schema.NullOr(MessageSource);

export const EntryKind = Schema.Literals(["system", "user", "assistant", "tool", "notice", "files", "answer", "compaction"]);
export type EntryKind = typeof EntryKind.Type;

export const FileStat = Schema.Struct({ size: Schema.Number, mtime: Schema.Number });
export type FileStat = typeof FileStat.Type;

const entryOf_ = <K extends EntryKind, M extends Schema.Top>(kind: K, message: M) =>
  Schema.Struct({
    seq: Int,
    bot: Int,
    kind: Schema.Literal(kind),
    message: Schema.fromJsonString(message),
    requestId: NullableText,
    toolCallId: NullableText,
    outcome: Schema.NullOr(ToolOutcome),
    source: Source,
    at: Schema.Number,
  }).pipe(Schema.encodeKeys({ requestId: "request_id", toolCallId: "tool_call_id" }));

export const StoredEntry = Schema.Union([
  entryOf_("system", SystemView),
  entryOf_("user", UserView),
  entryOf_("assistant", AssistantView),
  entryOf_("tool", ToolResultView),
  entryOf_("notice", NoticeView),
  entryOf_("files", FilesView),
  entryOf_("answer", AnswerView),
  entryOf_("compaction", CompactionView),
]);
export type StoredEntry = typeof StoredEntry.Type;

export const BotRow = Schema.Struct({
  id: Int,
  name: Text,
  avatar: Int,
  model: Text,
  runActive: Schema.BooleanFromBit,
  restarts: Int,
}).pipe(Schema.encodeKeys({ runActive: "run_active" }));
export type BotRow = typeof BotRow.Type;

export type LegacySoul = { readonly bot: number; readonly name: string; readonly description: string };

const InboxColumns = Schema.Struct({
  id: Int,
  bot: Int,
  requestId: Text,
  text: Text,
  mode: Schema.Literals(["steer", "followUp"]),
  clientId: NullableText,
  source: Source,
  attachments: Schema.NullOr(Schema.fromJsonString(Schema.Array(AttachmentSchema))),
  at: Schema.Number,
}).pipe(Schema.encodeKeys({ requestId: "request_id", clientId: "client_id" }));
export type InboxRow = Omit<typeof InboxColumns.Type, "attachments"> & { readonly attachments: readonly Attachment[] };

export const AttachmentRow = Schema.Struct({
  id: Text,
  bot: Schema.NullOr(Int),
  name: Text,
  mimeType: Text,
  size: Int,
  at: Schema.Number,
}).pipe(Schema.encodeKeys({ mimeType: "mime" }));
export type AttachmentRow = typeof AttachmentRow.Type;

export const WakeRow = Schema.Struct({ id: Int, bot: Int, dueAt: Schema.Number, note: Text, createdAt: Schema.Number }).pipe(
  Schema.encodeKeys({ dueAt: "due_at", createdAt: "created_at" }),
);
export type WakeRow = typeof WakeRow.Type;

export const JobState = Schema.Literals(["running", "finished", "stopped", "lost"]);
export type JobState = typeof JobState.Type;
export const JobRow = Schema.Struct({
  id: Int,
  bot: Int,
  tool: Text,
  summary: Text,
  note: Text,
  startedAt: Schema.Number,
  state: JobState,
}).pipe(Schema.encodeKeys({ startedAt: "started_at" }));
export type JobRow = typeof JobRow.Type;

type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;
export type AskBody = DistributiveOmit<Ask, "id">;
export type AskRow = { readonly id: number; readonly bot: number; readonly ask: Ask; readonly state: "pending" | AskOutcome };

const McpOAuthShape = Schema.Struct({ serverUrl: Schema.String, tokens: Schema.optionalKey(Schema.Struct({ access_token: Schema.String })) });
const isMcpOAuthShape = Schema.is(McpOAuthShape);
const McpOAuth = Schema.declare((u: unknown): u is McpOAuthState => isMcpOAuthShape(u), { title: "McpOAuthState" });

export const McpServerRow = Schema.Struct({
  id: Int,
  name: Text,
  config: Schema.fromJsonString(McpServerConfig),
  oauth: Schema.NullOr(Schema.fromJsonString(McpOAuth)),
});
export type McpServerRow = typeof McpServerRow.Type;

export const ToolCallRow = Schema.Struct({
  name: Text,
  args: Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
  startedAt: Schema.Number,
  finishedAt: Schema.NullOr(Schema.Number),
}).pipe(Schema.encodeKeys({ startedAt: "started_at", finishedAt: "finished_at" }));
export type ToolCallRow = typeof ToolCallRow.Type;

const FileRow = Schema.Struct({ path: Text, size: Schema.Number, mtime: Schema.Number });
const ContextRow = Schema.Struct({
  seq: Int,
  kind: Schema.Literals(["system", "user", "assistant", "tool"]),
  message: Schema.fromJsonString(Schema.Unknown),
});
const compactionOf = Schema.decodeUnknownSync(Schema.fromJsonString(CompactionView));
const answerOf = Schema.decodeUnknownSync(Schema.fromJsonString(AssistantView));

export type AppendExtra = {
  readonly requestId?: string | undefined;
  readonly toolCallId?: string | undefined;
  readonly outcome?: ToolOutcome | undefined;
  readonly source?: MessageSource | null | undefined;
  readonly at?: number | undefined;
};

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

const addColumn = (table: string, column: string, definition: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const columns = yield* sql.unsafe<{ name: string }>(`PRAGMA table_info(${table})`);
    if (!columns.some((c) => c.name === column)) yield* sql.unsafe(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  });

const MIGRATIONS: Record<string, Effect.Effect<void, SqlError, SqlClient.SqlClient>> = {
  "1_initial": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const statement of INITIAL_TABLES.split(";\n")) yield* sql.unsafe(statement);
    yield* addColumn("bots", "description", "TEXT NOT NULL DEFAULT ''");
    yield* addColumn("bots", "deleted", "INTEGER NOT NULL DEFAULT 0");
    yield* addColumn("bots", "files_scanned", "INTEGER NOT NULL DEFAULT 0");
    yield* addColumn("inbox", "source", "TEXT");
    yield* addColumn("entries", "source", "TEXT");
    yield* addColumn("inbox", "attachments", "TEXT");
    yield* addColumn("jobs", "note", "TEXT NOT NULL DEFAULT ''");
  }),
  "2_bot_avatar": addColumn("bots", "avatar", "INTEGER NOT NULL DEFAULT 0"),
  "3_permissions": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE permissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bot INTEGER NOT NULL REFERENCES bots(id),
      key TEXT NOT NULL UNIQUE,
      action TEXT NOT NULL,
      reason TEXT,
      state TEXT NOT NULL DEFAULT 'pending',
      at INTEGER NOT NULL
    )`;
    yield* sql`CREATE INDEX permissions_pending ON permissions(state, bot)`;
  }),
  "4_bot_skills": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE bot_skills (
      bot INTEGER NOT NULL REFERENCES bots(id),
      name TEXT NOT NULL,
      PRIMARY KEY (bot, name)
    )`;
  }),
  // Kept for older data; web search is on for every bot that can use it, whatever this says.
  "5_bot_web_search": addColumn("bots", "web_search", "INTEGER NOT NULL DEFAULT 0"),
  "6_context_files": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE legacy_souls (bot INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL)`;
    yield* sql`INSERT INTO legacy_souls (bot, name, description) SELECT id, name, description FROM bots WHERE deleted = 0`;
    yield* sql`ALTER TABLE bots DROP COLUMN description`;
    yield* sql`ALTER TABLE bots DROP COLUMN instructions`;
  }),
  "7_tasks": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const statement of TASK_TABLES.split(";\n")) yield* sql.unsafe(statement);
  }),
  "8_asks": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE asks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bot INTEGER NOT NULL REFERENCES bots(id),
      key TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      body TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending',
      at INTEGER NOT NULL
    )`;
    yield* sql`INSERT INTO asks (id, bot, key, kind, body, state, at)
      SELECT id, bot, key, 'permission',
        CASE WHEN reason IS NULL THEN json_object('action', action) ELSE json_object('action', action, 'reason', reason) END,
        state, at
      FROM permissions`;
    yield* sql`DROP TABLE permissions`;
    yield* sql`CREATE INDEX asks_pending ON asks(state, bot)`;
    yield* sql`UPDATE entries SET kind = 'answer' WHERE kind = 'permission'`;
    yield* sql`UPDATE entries SET source = 'answer' WHERE source = 'permission'`;
    yield* sql`UPDATE inbox SET source = 'answer' WHERE source = 'permission'`;
    yield* sql`UPDATE entries
      SET message = json_set(message, '$.details', json_object('ask', json_set(json_extract(message, '$.details.permission'), '$.kind', 'permission')))
      WHERE kind = 'tool' AND json_type(message, '$.details.permission') = 'object'`;
  }),
  // The order the bots are listed in, once someone reorders them; until then (NULL) it's the order they were made in.
  "9_bot_position": addColumn("bots", "position", "INTEGER"),
  "10_harness_runs": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe(HARNESS_RUNS_TABLE);
    yield* addColumn("tasks", "continues", "TEXT");
    yield* addColumn("tasks", "adopt", "TEXT");
    // Sessions from before Top kept this account start from what their thread shows at the first look; newer ones from
    // nothing.
    yield* addColumn("harness_sessions", "baselined", "INTEGER NOT NULL DEFAULT 0");
  }),
};

const refuseNewerData = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const ledger = yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'`;
  if (ledger.length === 0) return;
  const known = Math.max(...Object.keys(MIGRATIONS).map((key) => Number.parseInt(key, 10)));
  const newer = yield* sql<{ migration_id: number; name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id > ${known} ORDER BY migration_id`;
  if (newer.length === 0) return;
  return yield* new Migrator.MigrationError({
    kind: "BadState",
    message: `This data was written by a newer version of Top (it has migration ${newer.map((m) => `${m.migration_id}_${m.name}`).join(", ")}), so this version can't open it. Update Top, or start the version that wrote it.`,
  });
});

type Row = Record<string, unknown>;

const decoder =
  <A>(decode: (input: unknown) => A) =>
  (row: Row): A =>
    decode(row);
const entryOf = decoder(Schema.decodeUnknownSync(StoredEntry));
const inboxColumns = Schema.decodeUnknownSync(InboxColumns);
const inboxOf = (row: Row): InboxRow => {
  const decoded = inboxColumns(row);
  return { ...decoded, attachments: decoded.attachments ?? [] };
};
const attachmentOf = decoder(Schema.decodeUnknownSync(AttachmentRow));
const wakeOf = decoder(Schema.decodeUnknownSync(WakeRow));
const jobOf = decoder(Schema.decodeUnknownSync(JobRow));
const askOf = Schema.decodeUnknownSync(Ask);
const askRowOf = (row: Row): AskRow => ({
  id: Number(row.id),
  bot: Number(row.bot),
  ask: askOf({ ...JSON.parse(String(row.body)), kind: row.kind, id: Number(row.id) }),
  state: String(row.state) as AskRow["state"],
});
const mcpServerOf = decoder(Schema.decodeUnknownSync(McpServerRow));
const botOf = decoder(Schema.decodeUnknownSync(BotRow));
const toolCallOf = decoder(Schema.decodeUnknownSync(ToolCallRow));
const fileOf = decoder(Schema.decodeUnknownSync(FileRow));
const contextRow = Schema.decodeUnknownSync(ContextRow);
type ContextItem = { readonly seq: number | undefined; readonly message: TranscriptMessage };
const contextOf = (row: Row): ContextItem => {
  const { seq, kind, message } = contextRow(row);
  return { seq, message: transcriptMessage(kind, message) };
};

export const PLANNED_RESTART = "planned_restart";

export class Store extends Context.Service<
  Store,
  {
    readonly id: string;
    readonly filesSecret: string;
    readonly transaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;

    readonly bots: Effect.Effect<BotRow[]>;
    readonly bot: (id: number) => Effect.Effect<BotRow | undefined>;
    readonly createBot: (name: string, model: string, avatar?: number) => Effect.Effect<number>;
    /** Lists the bots in this order from now on; a bot made later goes after them. */
    readonly setBotOrder: (ids: readonly number[]) => Effect.Effect<void>;
    readonly legacySouls: Effect.Effect<LegacySoul[]>;
    readonly settleLegacySoul: (bot: number) => Effect.Effect<void>;
    readonly markDeleted: (bot: number) => Effect.Effect<void>;
    readonly purgeBot: (bot: number) => Effect.Effect<void>;
    readonly flag: (key: string) => Effect.Effect<boolean>;
    readonly setFlag: (key: string) => Effect.Effect<void>;
    readonly clearFlag: (key: string) => Effect.Effect<void>;
    readonly backup: (path: string) => Effect.Effect<void>;
    readonly setRunActive: (bot: number, active: boolean) => Effect.Effect<void>;
    readonly setRestarts: (bot: number, restarts: number) => Effect.Effect<void>;
    readonly setModel: (bot: number, model: string) => Effect.Effect<void>;

    readonly files: (bot: number) => Effect.Effect<Map<string, FileStat> | undefined>;
    readonly recordFiles: (bot: number, listing: ReadonlyMap<string, FileStat>, changes: readonly FileChange[]) => Effect.Effect<StoredEntry | undefined>;

    readonly mcpServers: Effect.Effect<McpServerRow[]>;
    readonly mcpServer: (id: number) => Effect.Effect<McpServerRow | undefined>;
    readonly createMcpServer: (name: string, config: McpServerConfig) => Effect.Effect<number>;
    readonly updateMcpServer: (id: number, name: string, config: McpServerConfig, resetOAuth: boolean) => Effect.Effect<void>;
    readonly setMcpOAuth: (id: number, oauth: McpOAuthState | null) => Effect.Effect<void>;
    readonly deleteMcpServer: (id: number) => Effect.Effect<void>;
    readonly mcpAssignments: Effect.Effect<Map<number, number[]>>;
    readonly assignMcp: (server: number, bot: number, on: boolean) => Effect.Effect<void>;

    readonly enabledSkills: Effect.Effect<Map<number, string[]>>;
    readonly enableSkills: (bot: number, names: readonly string[], on: boolean) => Effect.Effect<void>;

    readonly append: <K extends EntryKind>(bot: number, kind: K, message: EntryBody[K], extra?: AppendExtra) => Effect.Effect<StoredEntry>;
    readonly entry: (seq: number) => Effect.Effect<StoredEntry | undefined>;
    readonly context: (bot: number) => Effect.Effect<TranscriptMessage[]>;
    readonly compact: (bot: number, keep: number, summary: Omit<Compaction, "keptFrom">, notice: string) => Effect.Effect<StoredEntry>;
    readonly lastContextEntry: (bot: number) => Effect.Effect<StoredEntry | undefined>;
    readonly lastSeq: (bot: number) => Effect.Effect<number>;
    readonly lastAssistantSeq: (bot: number) => Effect.Effect<number>;
    readonly lastAnswer: (bot: number) => Effect.Effect<AssistantView | undefined>;
    readonly newest: (bot: number, limit: number) => Effect.Effect<StoredEntry[]>;
    readonly after: (bot: number, after: number, limit: number) => Effect.Effect<StoredEntry[]>;
    readonly hasBefore: (bot: number, seq: number) => Effect.Effect<boolean>;
    readonly history: (bot: number, before: number, after: number, limit: number) => Effect.Effect<{ entries: StoredEntry[]; more: boolean }>;
    readonly toolResultsAfter: (bot: number, seq: number) => Effect.Effect<Set<string>>;

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
    readonly place: (bot: number, requestId: string, message: EntryBody["user"]) => Effect.Effect<StoredEntry>;

    readonly addAttachment: (attachment: Attachment) => Effect.Effect<void>;
    readonly attachment: (id: string) => Effect.Effect<AttachmentRow | undefined>;
    readonly unclaimedAttachments: (before: number) => Effect.Effect<AttachmentRow[]>;
    readonly botAttachments: (bot: number) => Effect.Effect<AttachmentRow[]>;
    readonly deleteAttachment: (id: string) => Effect.Effect<void>;

    readonly addWake: (bot: number, key: string, dueAt: number, note: string) => Effect.Effect<WakeRow>;
    readonly wakes: (bot: number) => Effect.Effect<WakeRow[]>;
    readonly cancelWake: (bot: number, id: number) => Effect.Effect<boolean>;
    readonly nextWakeAt: Effect.Effect<number | undefined>;
    readonly dueWakes: (now: number) => Effect.Effect<WakeRow[]>;
    readonly fireWake: (wake: WakeRow, text: string) => Effect.Effect<InboxRow | undefined>;

    readonly startJob: (bot: number, key: string, tool: string, summary: string, note: string, startedAt: number) => Effect.Effect<number>;
    readonly job: (id: number) => Effect.Effect<JobRow | undefined>;
    readonly runningJobs: Effect.Effect<JobRow[]>;
    readonly endJob: (id: number, state: Exclude<JobState, "running">, text?: string) => Effect.Effect<InboxRow | undefined>;

    readonly ask: (bot: number, key: string, body: AskBody) => Effect.Effect<AskRow>;
    readonly askedBy: (key: string) => Effect.Effect<AskRow | undefined>;
    readonly waiting: Effect.Effect<AskRow[]>;
    readonly waitingOf: (bot: number) => Effect.Effect<AskRow[]>;
    readonly settle: (
      bot: number,
      id: number,
      outcome: AskOutcome,
      extra?: { readonly reply?: QuestionReply | undefined; readonly text?: string | undefined },
    ) => Effect.Effect<{ entry: StoredEntry; message: InboxRow | undefined } | undefined>;

    readonly toolStarted: (bot: number, assistantSeq: number, toolCallId: string, name: string, args: Readonly<Record<string, unknown>>) => Effect.Effect<void>;
    readonly toolFinished: (
      bot: number,
      assistantSeq: number,
      toolCallId: string,
      message: EntryBody["tool"],
      outcome?: ToolOutcome,
    ) => Effect.Effect<StoredEntry>;
    readonly toolCall: (assistantSeq: number, toolCallId: string) => Effect.Effect<ToolCallRow | undefined>;

    readonly tasks: TaskQueries;
  }
>()("top/Store") {}

const traced = (store: Store["Service"]): Store["Service"] => {
  const wrapped: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(store)) {
    if (name === "transaction") wrapped[name] = value;
    else if (Effect.isEffect(value)) wrapped[name] = Effect.withSpan(value as Effect.Effect<unknown>, `Store.${name}`);
    else if (typeof value === "function")
      wrapped[name] = (...args: unknown[]) => Effect.withSpan((value as (...a: unknown[]) => Effect.Effect<unknown>)(...args), `Store.${name}`);
    else wrapped[name] = value;
  }
  return wrapped as Store["Service"];
};

const VISIBLE = "kind NOT IN ('system', 'compaction')";
const CONTEXT = "kind IN ('system', 'user', 'assistant', 'tool')";

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`PRAGMA synchronous = FULL`;
  yield* sql`PRAGMA foreign_keys = ON`;
  yield* refuseNewerData;
  yield* Migrator.make({})({ loader: Migrator.fromRecord(MIGRATIONS) });

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

  const append = Effect.fnUntraced(function* <K extends EntryKind>(bot: number, kind: K, message: EntryBody[K], extra: AppendExtra = {}) {
    const at = extra.at ?? (yield* now);
    const json = JSON.stringify(message);
    const requestId = extra.requestId ?? null;
    const toolCallId = extra.toolCallId ?? null;
    const outcome = extra.outcome ?? null;
    const source = extra.source ?? null;
    const row = yield* first(sql`
      INSERT INTO entries (bot, kind, message, request_id, tool_call_id, outcome, source, at)
      VALUES (${bot}, ${kind}, ${json}, ${requestId}, ${toolCallId}, ${outcome}, ${source}, ${at})
      RETURNING *`);
    return entryOf(row!);
  });

  const context = (bot: number) =>
    Effect.gen(function* () {
      const items = (yield* rows(sql.unsafe(`SELECT seq, kind, message FROM entries WHERE bot = ? AND ${CONTEXT} ORDER BY seq`, [bot]))).map(contextOf);
      const latest = yield* first(sql`SELECT message FROM entries WHERE bot = ${bot} AND kind = 'compaction' ORDER BY seq DESC LIMIT 1`);
      if (!latest) return items;
      const compaction = compactionOf(latest.message);
      const baseline = getCurrentSystemMessage(items.filter((item) => item.seq! < compaction.keptFrom).map((item) => item.message));
      const after = items.filter((item) => item.seq! >= compaction.keptFrom);
      return [
        ...(baseline ? [{ seq: undefined, message: baseline }] : []),
        { seq: undefined, message: summaryMessage(compaction.summary, compaction.timestamp) },
        ...after,
      ];
    });

  const inboxRow = (requestId: string) => Effect.map(first(sql`SELECT * FROM inbox WHERE request_id = ${requestId}`), (row) => row && inboxOf(row));

  const queueEvent = Effect.fnUntraced(function* (bot: number, requestId: string, text: string, source: MessageSource) {
    yield* q(sql`
      INSERT INTO inbox (bot, request_id, text, mode, client_id, source, attachments, at)
      VALUES (${bot}, ${requestId}, ${text}, 'steer', NULL, ${source}, NULL, ${yield* now})`);
    return (yield* inboxRow(requestId))!;
  });

  const purgeBot = (bot: number) =>
    transaction(
      Effect.gen(function* () {
        for (const table of [
          ...TASK_PURGE_ORDER,
          "entries",
          "inbox",
          "tool_calls",
          "bot_mcp",
          "bot_skills",
          "files",
          "wakes",
          "jobs",
          "asks",
          "attachments",
          "legacy_souls",
        ])
          yield* q(sql.unsafe(`DELETE FROM ${table} WHERE bot = ?`, [bot]));
        yield* q(sql`DELETE FROM bots WHERE id = ${bot}`);
      }),
    );

  for (const row of yield* rows(sql`SELECT id FROM bots WHERE deleted = 1`)) yield* purgeBot(Number(row.id));

  return Store.of(
    traced({
      id,
      filesSecret,
      transaction,

      bots: Effect.map(rows(sql`SELECT * FROM bots WHERE deleted = 0 ORDER BY position IS NULL, position, id`), (r) => r.map(botOf)),
      setBotOrder: (ids) =>
        transaction(Effect.forEach(ids, (id, position) => q(sql`UPDATE bots SET position = ${position} WHERE id = ${id}`), { discard: true })),
      bot: (bot) => Effect.map(first(sql`SELECT * FROM bots WHERE id = ${bot}`), (row) => row && botOf(row)),
      createBot: (name, model, avatar = 0) =>
        Effect.map(first(sql`INSERT INTO bots (name, avatar, model) VALUES (${name}, ${avatar}, ${model}) RETURNING id`), (row) => Number(row!.id)),
      legacySouls: Effect.map(
        rows(sql`SELECT bot, legacy_souls.name, description FROM legacy_souls JOIN bots ON bots.id = legacy_souls.bot WHERE bots.deleted = 0 ORDER BY bot`),
        (r) => r.map((row) => ({ bot: Number(row.bot), name: String(row.name), description: String(row.description) })),
      ),
      settleLegacySoul: (bot) => Effect.asVoid(q(sql`DELETE FROM legacy_souls WHERE bot = ${bot}`)),
      markDeleted: (bot) =>
        transaction(
          Effect.gen(function* () {
            yield* q(sql`UPDATE bots SET deleted = 1, run_active = 0, name = ${`deleted:${bot}:${randomUUID()}`} WHERE id = ${bot}`);
            yield* q(sql`DELETE FROM inbox WHERE bot = ${bot}`);
            yield* q(sql`DELETE FROM bot_mcp WHERE bot = ${bot}`);
            yield* q(sql`DELETE FROM bot_skills WHERE bot = ${bot}`);
            yield* q(sql`UPDATE wakes SET state = 'cancelled' WHERE bot = ${bot} AND state = 'pending'`);
            yield* q(sql`UPDATE jobs SET state = 'stopped' WHERE bot = ${bot} AND state = 'running'`);
            yield* q(sql`UPDATE asks SET state = 'withdrawn' WHERE bot = ${bot} AND state = 'pending'`);
          }),
        ),
      purgeBot,
      flag: (key) => Effect.map(first(sql`SELECT 1 AS one FROM meta WHERE key = ${`flag:${key}`}`), (row) => row !== undefined),
      setFlag: (key) => Effect.asVoid(q(sql`INSERT OR IGNORE INTO meta (key, value) VALUES (${`flag:${key}`}, '1')`)),
      clearFlag: (key) => Effect.asVoid(q(sql`DELETE FROM meta WHERE key = ${`flag:${key}`}`)),
      backup: (path) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => rm(path, { force: true }));
          yield* q(sql`VACUUM INTO ${path}`);
          yield* q(sql`ATTACH DATABASE ${path} AS backup`);
          yield* q(sql`UPDATE backup.meta SET value = ${randomUUID()} WHERE key = 'id'`).pipe(
            Effect.andThen(q(sql`INSERT OR IGNORE INTO backup.meta (key, value) VALUES (${`flag:${PLANNED_RESTART}`}, '1')`)),
            Effect.ensuring(q(sql`DETACH DATABASE backup`)),
          );
        }),
      setRunActive: (bot, active) => Effect.asVoid(q(sql`UPDATE bots SET run_active = ${active ? 1 : 0} WHERE id = ${bot}`)),
      setRestarts: (bot, restarts) => Effect.asVoid(q(sql`UPDATE bots SET restarts = ${restarts} WHERE id = ${bot}`)),
      setModel: (bot, model) => Effect.asVoid(q(sql`UPDATE bots SET model = ${model} WHERE id = ${bot}`)),

      files: (bot) =>
        Effect.gen(function* () {
          const scanned = yield* first(sql`SELECT files_scanned FROM bots WHERE id = ${bot}`);
          if (!scanned || Number(scanned.files_scanned) !== 1) return undefined;
          const files = yield* rows(sql`SELECT path, size, mtime FROM files WHERE bot = ${bot}`);
          return new Map(files.map(fileOf).map(({ path, size, mtime }) => [path, { size, mtime }]));
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
        Effect.map(first(sql`INSERT INTO mcp_servers (name, config) VALUES (${name}, ${JSON.stringify(config)}) RETURNING id`), (row) => Number(row!.id)),
      updateMcpServer: (server, name, config, resetOAuth) =>
        Effect.asVoid(
          q(
            resetOAuth
              ? sql`UPDATE mcp_servers SET name = ${name}, config = ${JSON.stringify(config)}, oauth = NULL WHERE id = ${server}`
              : sql`UPDATE mcp_servers SET name = ${name}, config = ${JSON.stringify(config)} WHERE id = ${server}`,
          ),
        ),
      setMcpOAuth: (server, oauth) =>
        Effect.asVoid(q(sql`UPDATE mcp_servers SET oauth = ${oauth === null ? null : JSON.stringify(oauth)} WHERE id = ${server}`)),
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
            on
              ? sql`INSERT OR IGNORE INTO bot_mcp (bot, server) VALUES (${bot}, ${server})`
              : sql`DELETE FROM bot_mcp WHERE bot = ${bot} AND server = ${server}`,
          ),
        ),

      enabledSkills: Effect.map(
        rows(
          sql`SELECT bot_skills.bot, bot_skills.name FROM bot_skills JOIN bots ON bots.id = bot_skills.bot WHERE bots.deleted = 0 ORDER BY bot_skills.bot, bot_skills.name`,
        ),
        (enabled) => {
          const map = new Map<number, string[]>();
          for (const row of enabled) map.set(Number(row.bot), [...(map.get(Number(row.bot)) ?? []), String(row.name)]);
          return map;
        },
      ),
      enableSkills: (bot, names, on) =>
        transaction(
          Effect.forEach(
            names,
            (name) =>
              q(
                on
                  ? sql`INSERT OR IGNORE INTO bot_skills (bot, name) VALUES (${bot}, ${name})`
                  : sql`DELETE FROM bot_skills WHERE bot = ${bot} AND name = ${name}`,
              ),
            { discard: true },
          ),
        ),

      append,
      entry: (seq) => Effect.map(first(sql`SELECT * FROM entries WHERE seq = ${seq}`), (row) => row && entryOf(row)),
      context: (bot) => Effect.map(context(bot), (items) => items.map((item) => item.message)),
      compact: (bot, keep, summary, notice) =>
        transaction(
          Effect.gen(function* () {
            const items = yield* context(bot);
            const kept = items.slice(items.length - keep);
            if (keep > items.length || kept.some((item) => item.seq === undefined)) return yield* Effect.die(new Error(`Can't keep the last ${keep} messages`));
            const keptFrom = kept[0]?.seq ?? Number((yield* first(sql`SELECT MAX(seq) AS seq FROM entries`))?.seq ?? 0) + 1;
            yield* append(bot, "compaction", { ...summary, keptFrom });
            return yield* append(bot, "notice", { text: notice });
          }),
        ),
      lastContextEntry: (bot) =>
        Effect.map(first(sql.unsafe(`SELECT * FROM entries WHERE bot = ? AND ${CONTEXT} ORDER BY seq DESC LIMIT 1`, [bot])), (row) => row && entryOf(row)),
      lastSeq: (bot) =>
        Effect.map(first(sql.unsafe(`SELECT MAX(seq) AS seq FROM entries WHERE bot = ? AND ${VISIBLE}`, [bot])), (row) => Number(row?.seq ?? 0)),
      lastAssistantSeq: (bot) =>
        Effect.map(first(sql`SELECT MAX(seq) AS seq FROM entries WHERE bot = ${bot} AND kind = 'assistant'`), (row) => Number(row?.seq ?? 0)),
      lastAnswer: (bot) =>
        Effect.map(
          first(
            sql`SELECT message FROM entries WHERE bot = ${bot} AND kind = 'assistant' AND (
              (json_type(message, '$.content') = 'text' AND json_extract(message, '$.content') <> '')
              OR EXISTS (SELECT 1 FROM json_each(message, '$.content') WHERE json_extract(value, '$.type') = 'text' AND json_extract(value, '$.text') <> '')
            ) ORDER BY seq DESC LIMIT 1`,
          ),
          (row) => (row ? answerOf(row.message) : undefined),
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

      ask: (bot, key, { kind, ...body }) =>
        Effect.gen(function* () {
          yield* q(sql`INSERT OR IGNORE INTO asks (bot, key, kind, body, at) VALUES (${bot}, ${key}, ${kind}, ${JSON.stringify(body)}, ${yield* now})`);
          return askRowOf((yield* first(sql`SELECT * FROM asks WHERE key = ${key}`))!);
        }),
      askedBy: (key) => Effect.map(first(sql`SELECT * FROM asks WHERE key = ${key}`), (row) => row && askRowOf(row)),
      waiting: Effect.map(
        rows(sql`SELECT asks.* FROM asks JOIN bots ON bots.id = asks.bot WHERE state = 'pending' AND bots.deleted = 0 ORDER BY asks.id`),
        (r) => r.map(askRowOf),
      ),
      waitingOf: (bot) => Effect.map(rows(sql`SELECT * FROM asks WHERE bot = ${bot} AND state = 'pending' ORDER BY id`), (r) => r.map(askRowOf)),
      settle: (bot, id, outcome, extra = {}) =>
        transaction(
          Effect.gen(function* () {
            const settled = yield* rows(sql`UPDATE asks SET state = ${outcome} WHERE id = ${id} AND bot = ${bot} AND state = 'pending' RETURNING id`);
            if (!settled.length) return undefined;
            const entry = yield* append(bot, "answer", { request: id, answer: outcome, ...(extra.reply ? { reply: extra.reply } : {}) });
            const message = extra.text === undefined ? undefined : yield* queueEvent(bot, `answer:${id}`, extra.text, "answer");
            return { entry, message };
          }),
        ),

      toolStarted: (bot, assistantSeq, toolCallId, name, args) =>
        Effect.gen(function* () {
          yield* q(sql`
          INSERT OR IGNORE INTO tool_calls (assistant_seq, tool_call_id, bot, name, args, started_at)
          VALUES (${assistantSeq}, ${toolCallId}, ${bot}, ${name}, ${JSON.stringify(args)}, ${yield* now})`);
        }),
      toolFinished: (bot, assistantSeq, toolCallId, message, outcome) =>
        transaction(
          Effect.gen(function* () {
            yield* q(sql`UPDATE tool_calls SET finished_at = ${yield* now} WHERE assistant_seq = ${assistantSeq} AND tool_call_id = ${toolCallId}`);
            return yield* append(bot, "tool", message, { toolCallId, outcome });
          }),
        ),
      toolCall: (assistantSeq, toolCallId) =>
        Effect.map(
          first(sql`SELECT * FROM tool_calls WHERE assistant_seq = ${assistantSeq} AND tool_call_id = ${toolCallId}`),
          (row) => row && toolCallOf(row),
        ),

      tasks: makeTaskQueries(sql, transaction, (bot, requestId, text) => queueEvent(bot, requestId, text, "task")),
    }),
  );
});

export const layer: Layer.Layer<Store, SqlError | Migrator.MigrationError, SqlClient.SqlClient> = Layer.effect(Store, make);
