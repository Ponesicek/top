import { TaskDecision, TaskInputKind, TaskPolicy, TaskQuestion, TaskState } from "@top/protocol";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import type { InboxRow } from "../store.ts";

const Int = Schema.Int;
const Text = Schema.String;
const NullableText = Schema.NullOr(Schema.String);
const NullableNumber = Schema.NullOr(Schema.Number);
const Json = Schema.fromJsonString(Schema.Unknown);
const JsonObject = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));

export const TASK_TABLES = `
CREATE TABLE harness_sessions (
  id TEXT PRIMARY KEY,
  bot INTEGER NOT NULL REFERENCES bots(id),
  harness TEXT NOT NULL,
  location TEXT NOT NULL DEFAULT 'local',
  cwd TEXT NOT NULL,
  policy TEXT NOT NULL,
  model TEXT,
  options TEXT NOT NULL,
  external_id TEXT,
  parent TEXT,
  approved INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  used_at INTEGER NOT NULL
);
CREATE INDEX harness_sessions_by_bot ON harness_sessions(bot, used_at);
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  bot INTEGER NOT NULL REFERENCES bots(id),
  key TEXT NOT NULL UNIQUE,
  session TEXT NOT NULL REFERENCES harness_sessions(id),
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  images TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL,
  result TEXT,
  error TEXT,
  usage TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER,
  notified TEXT
);
CREATE INDEX tasks_by_bot ON tasks(bot, created_at);
CREATE INDEX tasks_by_state ON tasks(state);
CREATE TABLE task_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  task TEXT NOT NULL REFERENCES tasks(id),
  bot INTEGER NOT NULL,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL
);
CREATE INDEX task_events_by_task ON task_events(task, seq);
CREATE TABLE task_inputs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task TEXT NOT NULL REFERENCES tasks(id),
  bot INTEGER NOT NULL,
  kind TEXT NOT NULL,
  external TEXT,
  title TEXT NOT NULL,
  detail TEXT,
  spec TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  answer TEXT,
  answered_by TEXT,
  at INTEGER NOT NULL,
  answered_at INTEGER,
  UNIQUE (task, external)
);
CREATE INDEX task_inputs_pending ON task_inputs(state, task);
CREATE TABLE task_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task TEXT NOT NULL REFERENCES tasks(id),
  bot INTEGER NOT NULL,
  key TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL,
  text TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  at INTEGER NOT NULL
)`;

export const TASK_PURGE_ORDER = ["task_events", "task_messages", "task_inputs", "tasks", "harness_sessions"] as const;

export const SessionRow = Schema.Struct({
  id: Text,
  bot: Int,
  harness: Text,
  location: Schema.Literal("local"),
  cwd: Text,
  policy: TaskPolicy,
  model: NullableText,
  options: JsonObject,
  externalId: NullableText,
  parent: NullableText,
  approved: Schema.BooleanFromBit,
  createdAt: Schema.Number,
  usedAt: Schema.Number,
}).pipe(Schema.encodeKeys({ externalId: "external_id", createdAt: "created_at", usedAt: "used_at" }));
export type SessionRow = typeof SessionRow.Type;

export const TaskRow = Schema.Struct({
  id: Text,
  bot: Int,
  key: Text,
  session: Text,
  title: Text,
  prompt: Text,
  images: Schema.fromJsonString(Schema.Array(Schema.String)),
  state: TaskState,
  result: NullableText,
  error: NullableText,
  usage: Schema.NullOr(JsonObject),
  createdAt: Schema.Number,
  startedAt: NullableNumber,
  endedAt: NullableNumber,
  notified: NullableText,
}).pipe(Schema.encodeKeys({ createdAt: "created_at", startedAt: "started_at", endedAt: "ended_at" }));
export type TaskRow = typeof TaskRow.Type;

export const TaskEventKind = Schema.Literals([
  "state",
  "message",
  "reasoning",
  "command",
  "file_change",
  "tool",
  "input",
  "answer",
  "sent",
  "usage",
  "error",
  "status",
]);
export type TaskEventKind = typeof TaskEventKind.Type;

export const TaskEventRow = Schema.Struct({ seq: Int, task: Text, at: Schema.Number, kind: TaskEventKind, text: Text });
export type TaskEventRow = typeof TaskEventRow.Type;

export const InputSpec = Schema.Struct({
  decisions: Schema.optionalKey(Schema.Array(TaskDecision)),
  questions: Schema.optionalKey(Schema.Array(TaskQuestion)),
  userOnly: Schema.optionalKey(Schema.Boolean),
});
export type InputSpec = typeof InputSpec.Type;

export const InputState = Schema.Literals(["pending", "answered", "withdrawn"]);
export type InputState = typeof InputState.Type;
export const Answerer = Schema.Literals(["bot", "user"]);
export type Answerer = typeof Answerer.Type;

export const TaskInputRow = Schema.Struct({
  id: Int,
  task: Text,
  bot: Int,
  kind: TaskInputKind,
  external: NullableText,
  title: Text,
  detail: NullableText,
  spec: Schema.fromJsonString(InputSpec),
  state: InputState,
  answer: Schema.NullOr(Json),
  answeredBy: Schema.NullOr(Answerer),
  at: Schema.Number,
  answeredAt: NullableNumber,
}).pipe(Schema.encodeKeys({ answeredBy: "answered_by", answeredAt: "answered_at" }));
export type TaskInputRow = typeof TaskInputRow.Type;

export const MessageMode = Schema.Literals(["steer", "queue"]);
export type MessageMode = typeof MessageMode.Type;
export const TaskMessageRow = Schema.Struct({
  id: Int,
  task: Text,
  key: Text,
  mode: MessageMode,
  text: Text,
  state: Schema.Literals(["pending", "sent", "dropped"]),
  at: Schema.Number,
});
export type TaskMessageRow = typeof TaskMessageRow.Type;

const decode = <S extends Schema.Top>(schema: S) => {
  const run = Schema.decodeUnknownSync(schema as never) as (input: unknown) => S["Type"];
  return (row: Record<string, unknown>): S["Type"] => run(row);
};
const sessionOf = decode(SessionRow);
const taskOf = decode(TaskRow);
const eventOf = decode(TaskEventRow);
const inputOf = decode(TaskInputRow);
const messageOf = decode(TaskMessageRow);

export const ACTIVE_STATES = ["queued", "starting", "running", "waiting_for_input"] as const satisfies readonly TaskState[];

export type NewSession = Omit<SessionRow, "createdAt" | "usedAt" | "externalId" | "approved"> & { readonly approved: boolean };
export type NewTask = Pick<TaskRow, "id" | "bot" | "key" | "session" | "title" | "prompt" | "images">;
export type NewEvent = { readonly task: string; readonly bot: number; readonly at: number; readonly kind: TaskEventKind; readonly text: string };
export type TaskEnd = { readonly result?: string | undefined; readonly error?: string | undefined };

export type TaskQueries = ReturnType<typeof makeTaskQueries>;

export function makeTaskQueries(
  sql: SqlClient.SqlClient,
  transaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>,
  queue: (bot: number, requestId: string, text: string) => Effect.Effect<InboxRow>,
) {
  const q = <A>(effect: Effect.Effect<A, SqlError>): Effect.Effect<A> => Effect.orDie(effect);
  type Row = Record<string, unknown>;
  const rows = (effect: Effect.Effect<ReadonlyArray<Row>, SqlError>) => q(effect);
  const first = (effect: Effect.Effect<ReadonlyArray<Row>, SqlError>) => Effect.map(q(effect), (r) => r[0]);
  const now = Clock.currentTimeMillis;

  const task = (id: string) => Effect.map(first(sql`SELECT * FROM tasks WHERE id = ${id}`), (row) => row && taskOf(row));
  const session = (id: string) => Effect.map(first(sql`SELECT * FROM harness_sessions WHERE id = ${id}`), (row) => row && sessionOf(row));
  const input = (id: number) => Effect.map(first(sql`SELECT * FROM task_inputs WHERE id = ${id}`), (row) => row && inputOf(row));

  return {
    createSession: (row: NewSession) =>
      Effect.gen(function* () {
        const at = yield* now;
        yield* q(sql`
          INSERT INTO harness_sessions (id, bot, harness, location, cwd, policy, model, options, parent, approved, created_at, used_at)
          VALUES (${row.id}, ${row.bot}, ${row.harness}, ${row.location}, ${row.cwd}, ${row.policy}, ${row.model}, ${JSON.stringify(row.options)},
                  ${row.parent}, ${row.approved ? 1 : 0}, ${at}, ${at})`);
        return (yield* session(row.id))!;
      }),
    session,
    sessionsOf: (bot: number, limit: number) =>
      Effect.map(rows(sql`SELECT * FROM harness_sessions WHERE bot = ${bot} ORDER BY used_at DESC LIMIT ${limit}`), (r) => r.map(sessionOf)),
    setExternalId: (id: string, externalId: string) =>
      Effect.asVoid(q(sql`UPDATE harness_sessions SET external_id = ${externalId} WHERE id = ${id} AND (external_id IS NULL OR external_id = ${externalId})`)),
    approveSession: (id: string) => Effect.asVoid(q(sql`UPDATE harness_sessions SET approved = 1 WHERE id = ${id}`)),
    touchSession: (id: string) => Effect.flatMap(now, (at) => Effect.asVoid(q(sql`UPDATE harness_sessions SET used_at = ${at} WHERE id = ${id}`))),

    createTask: (row: NewTask, state: TaskState) =>
      Effect.gen(function* () {
        const at = yield* now;
        yield* q(sql`
          INSERT INTO tasks (id, bot, key, session, title, prompt, images, state, created_at)
          VALUES (${row.id}, ${row.bot}, ${row.key}, ${row.session}, ${row.title}, ${row.prompt}, ${JSON.stringify(row.images)}, ${state}, ${at})`);
        return (yield* task(row.id))!;
      }),
    task,
    taskByKey: (key: string) => Effect.map(first(sql`SELECT * FROM tasks WHERE key = ${key}`), (row) => row && taskOf(row)),
    tasksOf: (bot: number, limit: number) =>
      Effect.map(rows(sql`SELECT * FROM tasks WHERE bot = ${bot} ORDER BY created_at DESC, id DESC LIMIT ${limit}`), (r) => r.map(taskOf)),
    unnotified: Effect.map(
      rows(sql`
        SELECT * FROM tasks WHERE state IN ('completed', 'failed', 'cancelled') AND (notified IS NULL OR notified != state)
        ORDER BY ended_at, id`),
      (r) => r.map(taskOf),
    ),
    activeTasks: Effect.map(rows(sql`SELECT * FROM tasks WHERE state IN ('queued', 'starting', 'running', 'waiting_for_input') ORDER BY created_at, id`), (r) =>
      r.map(taskOf),
    ),
    recentTasks: (limit: number) =>
      Effect.map(
        rows(sql`
          SELECT * FROM tasks WHERE state IN ('queued', 'starting', 'running', 'waiting_for_input')
          UNION
          SELECT * FROM (SELECT * FROM tasks ORDER BY created_at DESC, id DESC LIMIT ${limit})
          ORDER BY created_at, id`),
        (r) => r.map(taskOf),
      ),
    sessionBusy: (session: string, except: string) =>
      Effect.map(
        first(sql`SELECT id FROM tasks WHERE session = ${session} AND id != ${except} AND state IN ('starting', 'running', 'waiting_for_input') LIMIT 1`),
        (row) => (row ? String(row.id) : undefined),
      ),

    setState: (id: string, from: readonly TaskState[], to: TaskState, end: TaskEnd = {}) =>
      Effect.gen(function* () {
        const at = yield* now;
        const ended = to === "completed" || to === "failed" || to === "cancelled";
        const list = sql.in(from);
        const row = yield* first(sql`
          UPDATE tasks SET state = ${to},
            started_at = CASE WHEN ${to} = 'starting' AND started_at IS NULL THEN ${at} ELSE started_at END,
            ended_at = CASE WHEN ${ended ? 1 : 0} = 1 THEN ${at} ELSE ended_at END,
            result = COALESCE(${end.result ?? null}, result),
            error = COALESCE(${end.error ?? null}, error)
          WHERE id = ${id} AND state IN ${list}
          RETURNING *`);
        return row ? taskOf(row) : undefined;
      }),
    setUsage: (id: string, usage: Readonly<Record<string, unknown>>) =>
      Effect.asVoid(q(sql`UPDATE tasks SET usage = ${JSON.stringify(usage)} WHERE id = ${id}`)),

    appendEvents: (events: readonly NewEvent[]) =>
      events.length === 0
        ? Effect.void
        : transaction(
            Effect.forEach(
              events,
              (e) =>
                q(sql`
                  INSERT INTO task_events (task, bot, at, kind, text)
                  SELECT ${e.task}, ${e.bot}, ${e.at}, ${e.kind}, ${e.text} WHERE EXISTS (SELECT 1 FROM tasks WHERE id = ${e.task})`),
              { discard: true },
            ),
          ),
    events: (id: string, after: number, limit: number) =>
      Effect.gen(function* () {
        const found = (yield* rows(
          sql`SELECT seq, task, at, kind, text FROM task_events WHERE task = ${id} AND seq > ${after} ORDER BY seq LIMIT ${limit + 1}`,
        )).map(eventOf);
        return { events: found.slice(0, limit), more: found.length > limit };
      }),
    lastEventSeq: (id: string) => Effect.map(first(sql`SELECT MAX(seq) AS seq FROM task_events WHERE task = ${id}`), (row) => Number(row?.seq ?? 0)),
    firstEventSeq: (id: string) => Effect.map(first(sql`SELECT MIN(seq) AS seq FROM task_events WHERE task = ${id}`), (row) => Number(row?.seq ?? 0)),
    pruneEvents: (id: string, keep: number) =>
      Effect.asVoid(
        q(
          sql`DELETE FROM task_events WHERE task = ${id} AND seq < (SELECT seq FROM task_events WHERE task = ${id} ORDER BY seq DESC LIMIT 1 OFFSET ${keep - 1})`,
        ),
      ),

    addInput: (row: {
      readonly task: string;
      readonly bot: number;
      readonly kind: TaskInputRow["kind"];
      readonly external: string | null;
      readonly title: string;
      readonly detail: string | null;
      readonly spec: InputSpec;
    }) =>
      Effect.gen(function* () {
        const at = yield* now;
        const inserted = yield* first(sql`
          INSERT INTO task_inputs (task, bot, kind, external, title, detail, spec, at)
          VALUES (${row.task}, ${row.bot}, ${row.kind}, ${row.external}, ${row.title}, ${row.detail}, ${JSON.stringify(row.spec)}, ${at})
          ON CONFLICT (task, external) DO NOTHING
          RETURNING id`);
        if (inserted) return { input: (yield* input(Number(inserted.id)))!, created: true };
        const existing = yield* first(sql`SELECT * FROM task_inputs WHERE task = ${row.task} AND external = ${row.external}`);
        return { input: inputOf(existing!), created: false };
      }),
    input,
    inputsOf: (id: string) => Effect.map(rows(sql`SELECT * FROM task_inputs WHERE task = ${id} ORDER BY id`), (r) => r.map(inputOf)),
    pendingInputs: Effect.map(rows(sql`SELECT * FROM task_inputs WHERE state = 'pending' ORDER BY id`), (r) => r.map(inputOf)),
    answerInput: (id: number, answer: unknown, by: Answerer) =>
      Effect.gen(function* () {
        const at = yield* now;
        const row = yield* first(sql`
          UPDATE task_inputs SET state = 'answered', answer = ${JSON.stringify(answer)}, answered_by = ${by}, answered_at = ${at}
          WHERE id = ${id} AND state = 'pending' RETURNING *`);
        return row ? inputOf(row) : undefined;
      }),
    withdrawInput: (id: number) =>
      Effect.map(first(sql`UPDATE task_inputs SET state = 'withdrawn' WHERE id = ${id} AND state = 'pending' RETURNING *`), (row) => row && inputOf(row)),
    withdrawInputs: (id: string) =>
      Effect.map(rows(sql`UPDATE task_inputs SET state = 'withdrawn' WHERE task = ${id} AND state = 'pending' RETURNING *`), (r) => r.map(inputOf)),

    addMessage: (row: { readonly task: string; readonly bot: number; readonly key: string; readonly mode: MessageMode; readonly text: string }) =>
      Effect.gen(function* () {
        const at = yield* now;
        const inserted = yield* first(sql`
          INSERT INTO task_messages (task, bot, key, mode, text, at) VALUES (${row.task}, ${row.bot}, ${row.key}, ${row.mode}, ${row.text}, ${at})
          ON CONFLICT (key) DO NOTHING RETURNING *`);
        if (inserted) return { message: messageOf(inserted), created: true };
        return { message: messageOf((yield* first(sql`SELECT * FROM task_messages WHERE key = ${row.key}`))!), created: false };
      }),
    messageByKey: (key: string) => Effect.map(first(sql`SELECT * FROM task_messages WHERE key = ${key}`), (row) => row && messageOf(row)),
    pendingMessages: (id: string) =>
      Effect.map(rows(sql`SELECT * FROM task_messages WHERE task = ${id} AND state = 'pending' ORDER BY id`), (r) => r.map(messageOf)),
    setMessageState: (id: number, state: "sent" | "dropped") =>
      Effect.map(first(sql`UPDATE task_messages SET state = ${state} WHERE id = ${id} AND state = 'pending' RETURNING id`), (row) => row !== undefined),
    dropMessages: (id: string) =>
      Effect.map(rows(sql`UPDATE task_messages SET state = 'dropped' WHERE task = ${id} AND state = 'pending' RETURNING id`), (r) => r.length),

    notify: (id: string, key: string, text: string | undefined) =>
      transaction(
        Effect.gen(function* () {
          const row = yield* first(sql`UPDATE tasks SET notified = ${key} WHERE id = ${id} AND (notified IS NULL OR notified != ${key}) RETURNING bot`);
          if (!row || text === undefined) return undefined;
          return yield* queue(Number(row.bot), `task:${id}:${key}`, text);
        }),
      ),
  };
}
