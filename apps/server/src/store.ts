/**
 * The daemon's one SQLite file. Every write is a synchronous transaction with `synchronous=FULL`, so
 * when a call returns, the data survives a kill -9 or a power cut. That is the whole durability story:
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
 * - `mcp_servers`: MCP connections set up in the app, with their secrets and OAuth credentials, and
 *   `bot_mcp`: which bots use which. A bot has none until it is given one.
 */
import { randomUUID } from "node:crypto";
import { DatabaseSync, type StatementSync } from "node:sqlite";

export type EntryKind = "system" | "user" | "assistant" | "tool" | "notice";

export type StoredEntry = {
  readonly seq: number;
  readonly bot: number;
  readonly kind: EntryKind;
  /** JSON: an agent message (system/user/assistant/toolResult), or `{ text }` for a notice. */
  readonly message: string;
  readonly requestId: string | null;
  readonly toolCallId: string | null;
  readonly outcome: string | null;
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
  readonly at: number;
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

const SCHEMA = `
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
`;

type Row = Record<string, unknown>;

function entryOf(row: Row): StoredEntry {
  return {
    seq: Number(row.seq),
    bot: Number(row.bot),
    kind: row.kind as EntryKind,
    message: String(row.message),
    requestId: (row.request_id as string | null) ?? null,
    toolCallId: (row.tool_call_id as string | null) ?? null,
    outcome: (row.outcome as string | null) ?? null,
    at: Number(row.at),
  };
}

function inboxOf(row: Row): InboxRow {
  return {
    id: Number(row.id),
    bot: Number(row.bot),
    requestId: String(row.request_id),
    text: String(row.text),
    mode: row.mode === "steer" ? "steer" : "followUp",
    clientId: (row.client_id as string | null) ?? null,
    at: Number(row.at),
  };
}

function mcpServerOf(row: Row): McpServerRow {
  return { id: Number(row.id), name: String(row.name), config: String(row.config), oauth: (row.oauth as string | null) ?? null };
}

const VISIBLE = "kind != 'system'";

export class Store {
  /** Names this data, for clients: made once, kept across restarts. */
  readonly id: string;
  readonly #db: DatabaseSync;
  readonly #q: Record<string, StatementSync>;

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.#db.exec(SCHEMA);
    // Columns added after the first release.
    const columns = new Set(this.#db.prepare("PRAGMA table_info(bots)").all().map((row) => String(row.name)));
    if (!columns.has("description")) this.#db.exec("ALTER TABLE bots ADD COLUMN description TEXT NOT NULL DEFAULT ''");
    if (!columns.has("deleted")) this.#db.exec("ALTER TABLE bots ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0");
    this.#db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('id', ?)").run(randomUUID());
    this.id = String((this.#db.prepare("SELECT value FROM meta WHERE key = 'id'").get() as { value: string }).value);
    const p = (sql: string) => this.#db.prepare(sql);
    this.#q = {
      bots: p("SELECT * FROM bots WHERE deleted = 0 ORDER BY id"),
      bot: p("SELECT * FROM bots WHERE id = ?"),
      insertBot: p("INSERT INTO bots (name, description, instructions, model) VALUES (?, ?, ?, ?)"),
      append: p("INSERT INTO entries (bot, kind, message, request_id, tool_call_id, outcome, at) VALUES (?, ?, ?, ?, ?, ?, ?)"),
      entry: p("SELECT * FROM entries WHERE seq = ?"),
      context: p("SELECT kind, message FROM entries WHERE bot = ? AND kind != 'notice' ORDER BY seq"),
      last: p("SELECT * FROM entries WHERE bot = ? AND kind != 'notice' ORDER BY seq DESC LIMIT 1"),
      lastSeq: p(`SELECT MAX(seq) AS seq FROM entries WHERE bot = ? AND ${VISIBLE}`),
      lastAssistantSeq: p("SELECT MAX(seq) AS seq FROM entries WHERE bot = ? AND kind = 'assistant'"),
      lastAnswer: p("SELECT message FROM entries WHERE bot = ? AND kind = 'assistant' ORDER BY seq DESC LIMIT 1"),
      newest: p(`SELECT * FROM entries WHERE bot = ? AND ${VISIBLE} ORDER BY seq DESC LIMIT ?`),
      after: p(`SELECT * FROM entries WHERE bot = ? AND ${VISIBLE} AND seq > ? ORDER BY seq LIMIT ?`),
      countBefore: p(`SELECT EXISTS(SELECT 1 FROM entries WHERE bot = ? AND ${VISIBLE} AND seq < ?) AS any`),
      between: p(`SELECT * FROM entries WHERE bot = ? AND ${VISIBLE} AND seq < ? AND seq > ? ORDER BY seq DESC LIMIT ?`),
      resultsAfter: p("SELECT tool_call_id FROM entries WHERE bot = ? AND kind = 'tool' AND seq > ?"),
      requestInEntries: p("SELECT 1 FROM entries WHERE request_id = ?"),
      requestInInbox: p("SELECT 1 FROM inbox WHERE request_id = ?"),
      insertInbox: p("INSERT INTO inbox (bot, request_id, text, mode, client_id, at) VALUES (?, ?, ?, ?, ?, ?)"),
      inbox: p("SELECT * FROM inbox WHERE bot = ? ORDER BY id"),
      inboxRow: p("SELECT * FROM inbox WHERE request_id = ?"),
      deleteInbox: p("DELETE FROM inbox WHERE request_id = ?"),
      toolStarted: p("INSERT OR IGNORE INTO tool_calls (assistant_seq, tool_call_id, bot, name, args, started_at) VALUES (?, ?, ?, ?, ?, ?)"),
      toolFinished: p("UPDATE tool_calls SET finished_at = ? WHERE assistant_seq = ? AND tool_call_id = ?"),
      toolCall: p("SELECT * FROM tool_calls WHERE assistant_seq = ? AND tool_call_id = ?"),
      setRunActive: p("UPDATE bots SET run_active = ? WHERE id = ?"),
      setRestarts: p("UPDATE bots SET restarts = ? WHERE id = ?"),
      setModel: p("UPDATE bots SET model = ? WHERE id = ?"),
    };
    // Bots deleted just before a crash or a stop: finish the job.
    for (const row of this.#db.prepare("SELECT id FROM bots WHERE deleted = 1").all()) this.purgeBot(Number(row.id));
  }

  /** Run `fn` as one transaction. */
  transaction<T>(fn: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  close() {
    this.#db.close();
  }

  // ── bots ─────────────────────────────────────────────────────────────────────

  /** The bots that aren't deleted. */
  bots(): BotRow[] {
    return this.#q.bots!.all().map((row) => this.#botOf(row));
  }

  /** One bot, also while it is being deleted. */
  bot(id: number): BotRow | undefined {
    const row = this.#q.bot!.get(id);
    return row ? this.#botOf(row) : undefined;
  }

  createBot(name: string, instructions: string, model: string, description = ""): number {
    return Number(this.#q.insertBot!.run(name, description, instructions, model).lastInsertRowid);
  }

  /**
   * First half of deleting a bot: it leaves the roster, its queue is dropped and its name is free for a
   * new bot, but its rows stay so a step it is finishing can still be written. `purgeBot` removes them.
   */
  markDeleted(bot: number) {
    this.transaction(() => {
      this.#db.prepare("UPDATE bots SET deleted = 1, run_active = 0, name = ? WHERE id = ?").run(`deleted:${bot}:${randomUUID()}`, bot);
      this.#db.prepare("DELETE FROM inbox WHERE bot = ?").run(bot);
      this.#db.prepare("DELETE FROM bot_mcp WHERE bot = ?").run(bot);
    });
  }

  /** Remove a bot and everything it wrote. */
  purgeBot(bot: number) {
    this.transaction(() => {
      for (const table of ["entries", "inbox", "tool_calls", "bot_mcp"]) this.#db.prepare(`DELETE FROM ${table} WHERE bot = ?`).run(bot);
      this.#db.prepare("DELETE FROM bots WHERE id = ?").run(bot);
    });
  }

  /** A flag kept in the meta table (e.g. that the first bots were made, so deleting them all doesn't bring them back). */
  flag(key: string): boolean {
    return this.#db.prepare("SELECT 1 FROM meta WHERE key = ?").get(`flag:${key}`) !== undefined;
  }

  setFlag(key: string) {
    this.#db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES (?, '1')").run(`flag:${key}`);
  }

  setRunActive(bot: number, active: boolean) {
    this.#q.setRunActive!.run(active ? 1 : 0, bot);
  }

  setRestarts(bot: number, restarts: number) {
    this.#q.setRestarts!.run(restarts, bot);
  }

  /** `provider/model-id`. Takes effect when the daemon next starts. */
  setModel(bot: number, model: string) {
    this.#q.setModel!.run(model, bot);
  }

  #botOf(row: Row): BotRow {
    return {
      id: Number(row.id),
      name: String(row.name),
      description: String(row.description ?? ""),
      instructions: String(row.instructions),
      model: String(row.model),
      runActive: Number(row.run_active) === 1,
      restarts: Number(row.restarts),
    };
  }

  // ── MCP servers ──────────────────────────────────────────────────────────────

  mcpServers(): McpServerRow[] {
    return this.#db.prepare("SELECT * FROM mcp_servers ORDER BY id").all().map(mcpServerOf);
  }

  mcpServer(id: number): McpServerRow | undefined {
    const row = this.#db.prepare("SELECT * FROM mcp_servers WHERE id = ?").get(id);
    return row ? mcpServerOf(row) : undefined;
  }

  createMcpServer(name: string, config: string): number {
    return Number(this.#db.prepare("INSERT INTO mcp_servers (name, config) VALUES (?, ?)").run(name, config).lastInsertRowid);
  }

  /** Change a server's name and settings. `resetOAuth` drops its credentials (they were for another URL). */
  updateMcpServer(id: number, name: string, config: string, resetOAuth: boolean) {
    this.#db.prepare(`UPDATE mcp_servers SET name = ?, config = ?${resetOAuth ? ", oauth = NULL" : ""} WHERE id = ?`).run(name, config, id);
  }

  setMcpOAuth(id: number, oauth: string | null) {
    this.#db.prepare("UPDATE mcp_servers SET oauth = ? WHERE id = ?").run(oauth, id);
  }

  deleteMcpServer(id: number) {
    this.transaction(() => {
      this.#db.prepare("DELETE FROM bot_mcp WHERE server = ?").run(id);
      this.#db.prepare("DELETE FROM mcp_servers WHERE id = ?").run(id);
    });
  }

  /** The bots (not deleted) that use each server: server id → bot ids. */
  mcpAssignments(): Map<number, number[]> {
    const map = new Map<number, number[]>();
    const rows = this.#db.prepare("SELECT bot, server FROM bot_mcp JOIN bots ON bots.id = bot_mcp.bot WHERE bots.deleted = 0 ORDER BY bot").all();
    for (const row of rows) {
      const server = Number(row.server);
      map.set(server, [...(map.get(server) ?? []), Number(row.bot)]);
    }
    return map;
  }

  assignMcp(server: number, bot: number, on: boolean) {
    if (on) this.#db.prepare("INSERT OR IGNORE INTO bot_mcp (bot, server) VALUES (?, ?)").run(bot, server);
    else this.#db.prepare("DELETE FROM bot_mcp WHERE bot = ? AND server = ?").run(bot, server);
  }

  // ── entries ──────────────────────────────────────────────────────────────────

  append(
    bot: number,
    kind: EntryKind,
    message: unknown,
    extra: { requestId?: string; toolCallId?: string; outcome?: string; at?: number } = {},
  ): StoredEntry {
    const at = extra.at ?? Date.now();
    const json = JSON.stringify(message);
    const result = this.#q.append!.run(bot, kind, json, extra.requestId ?? null, extra.toolCallId ?? null, extra.outcome ?? null, at);
    return {
      seq: Number(result.lastInsertRowid),
      bot,
      kind,
      message: json,
      requestId: extra.requestId ?? null,
      toolCallId: extra.toolCallId ?? null,
      outcome: extra.outcome ?? null,
      at,
    };
  }

  entry(seq: number): StoredEntry | undefined {
    const row = this.#q.entry!.get(seq);
    return row ? entryOf(row) : undefined;
  }

  /** Every message the model sees, in order. */
  context(bot: number): { kind: EntryKind; message: unknown }[] {
    return this.#q.context!.all(bot).map((row) => ({ kind: row.kind as EntryKind, message: JSON.parse(String(row.message)) }));
  }

  /** The newest entry that is part of the model's context. */
  lastContextEntry(bot: number): StoredEntry | undefined {
    const row = this.#q.last!.get(bot);
    return row ? entryOf(row) : undefined;
  }

  lastSeq(bot: number): number {
    return Number(this.#q.lastSeq!.get(bot)?.seq ?? 0);
  }

  lastAssistantSeq(bot: number): number {
    return Number(this.#q.lastAssistantSeq!.get(bot)?.seq ?? 0);
  }

  lastAnswer(bot: number): unknown {
    const row = this.#q.lastAnswer!.get(bot);
    return row ? JSON.parse(String(row.message)) : undefined;
  }

  /** The newest `limit` visible entries, ascending. */
  newest(bot: number, limit: number): StoredEntry[] {
    return this.#q.newest!.all(bot, limit).map(entryOf).reverse();
  }

  /** Up to `limit` visible entries after `after`, ascending. */
  after(bot: number, after: number, limit: number): StoredEntry[] {
    return this.#q.after!.all(bot, after, limit).map(entryOf);
  }

  hasBefore(bot: number, seq: number): boolean {
    return Number(this.#q.countBefore!.get(bot, seq)?.any) === 1;
  }

  /** Visible entries with after < seq < before, the newest `limit` of them, ascending; `more` if older ones remain. */
  history(bot: number, before: number, after: number, limit: number): { entries: StoredEntry[]; more: boolean } {
    const rows = this.#q.between!.all(bot, before, after, limit + 1).map(entryOf);
    const more = rows.length > limit;
    return { entries: rows.slice(0, limit).reverse(), more };
  }

  /** Tool call IDs that already have a result after the given entry. */
  toolResultsAfter(bot: number, seq: number): Set<string> {
    return new Set(this.#q.resultsAfter!.all(bot, seq).map((row) => String(row.tool_call_id)));
  }

  // ── inbox ────────────────────────────────────────────────────────────────────

  /** Accept a message. A `requestId` seen before (queued or already placed) is a duplicate and changes nothing. */
  submit(bot: number, requestId: string, text: string, mode: "steer" | "followUp", clientId: string | null): "queued" | "duplicate" {
    return this.transaction(() => {
      if (this.#q.requestInEntries!.get(requestId) || this.#q.requestInInbox!.get(requestId)) return "duplicate";
      this.#q.insertInbox!.run(bot, requestId, text, mode, clientId, Date.now());
      return "queued";
    });
  }

  inbox(bot: number): InboxRow[] {
    return this.#q.inbox!.all(bot).map(inboxOf);
  }

  inboxRow(requestId: string): InboxRow | undefined {
    const row = this.#q.inboxRow!.get(requestId);
    return row ? inboxOf(row) : undefined;
  }

  /** The model took a queued message: it becomes an entry and leaves the inbox, atomically. */
  place(bot: number, requestId: string, message: unknown): StoredEntry {
    return this.transaction(() => {
      this.#q.deleteInbox!.run(requestId);
      return this.append(bot, "user", message, { requestId });
    });
  }

  // ── tool calls ───────────────────────────────────────────────────────────────

  toolStarted(bot: number, assistantSeq: number, toolCallId: string, name: string, args: unknown) {
    this.#q.toolStarted!.run(assistantSeq, toolCallId, bot, name, JSON.stringify(args ?? {}), Date.now());
  }

  /** A tool's result and the end of its call record, atomically. */
  toolFinished(bot: number, assistantSeq: number, toolCallId: string, message: unknown, outcome?: string): StoredEntry {
    return this.transaction(() => {
      this.#q.toolFinished!.run(Date.now(), assistantSeq, toolCallId);
      return this.append(bot, "tool", message, { toolCallId, outcome });
    });
  }

  toolCall(assistantSeq: number, toolCallId: string): ToolCallRow | undefined {
    const row = this.#q.toolCall!.get(assistantSeq, toolCallId);
    if (!row) return undefined;
    return {
      name: String(row.name),
      args: String(row.args),
      startedAt: Number(row.started_at),
      finishedAt: row.finished_at === null ? null : Number(row.finished_at),
    };
  }
}
