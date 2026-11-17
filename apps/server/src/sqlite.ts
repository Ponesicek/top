import { DatabaseSync, type StatementSync } from "node:sqlite";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Reactivity from "effect/reactivity/Reactivity";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Client from "effect/sql/SqlClient";
import type { Connection } from "effect/sql/SqlConnection";
import { classifySqliteError, SqlError } from "effect/sql/SqlError";
import * as Statement from "effect/sql/Statement";

export type SqliteConfig = {
  readonly filename: string;
  readonly busyTimeoutMs?: number | undefined;
};

const MAX_CACHED_STATEMENTS = 500;

const failure = (operation: string, message: string) => (cause: unknown) => new SqlError({ reason: classifySqliteError(cause, { message, operation }) });

interface SqliteConnection extends Connection {
  readonly isTransaction: () => boolean;
}

const makeConnection = (config: SqliteConfig): Effect.Effect<SqliteConnection, SqlError, Scope.Scope> =>
  Effect.gen(function* () {
    const db = yield* Effect.acquireRelease(
      Effect.try({ try: () => new DatabaseSync(config.filename), catch: failure("connect", "Failed to open database") }),
      (db) => Effect.sync(() => db.isOpen && db.close()),
    );
    yield* Effect.try({
      try: () => {
        db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.round(config.busyTimeoutMs ?? 5_000))};`);
        if (config.filename !== ":memory:") db.exec("PRAGMA journal_mode = WAL;");
      },
      catch: failure("connect", "Failed to configure database"),
    });

    const statements = new Map<string, StatementSync>();
    const prepare = (sql: string, safeIntegers: boolean): StatementSync => {
      let statement = statements.get(sql);
      if (!statement) {
        if (statements.size >= MAX_CACHED_STATEMENTS) statements.clear();
        statement = db.prepare(sql);
        statements.set(sql, statement);
      }
      statement.setReadBigInts(safeIntegers);
      return statement;
    };

    const run = (sql: string, params: ReadonlyArray<unknown>, cached: boolean) =>
      Effect.withFiber<Array<Record<string, unknown>>, SqlError>((fiber) => {
        const safeIntegers = Context.get(fiber.context, Client.SafeIntegers);
        try {
          const statement = cached ? prepare(sql, safeIntegers) : db.prepare(sql);
          if (!cached) statement.setReadBigInts(safeIntegers);
          return Effect.succeed(statement.all(...(params as Array<never>)) as Array<Record<string, unknown>>);
        } catch (cause) {
          return Effect.fail(failure("execute", "Failed to execute statement")(cause));
        }
      });

    const values = (rows: ReadonlyArray<Record<string, unknown>>) => rows.map((row) => Object.values(row));

    return {
      isTransaction: () => db.isTransaction,
      execute: (sql, params, transformRows) => (transformRows ? Effect.map(run(sql, params, true), transformRows) : run(sql, params, true)),
      executeRaw: (sql, params) => run(sql, params, true),
      executeValues: (sql, params) => Effect.map(run(sql, params, true), values),
      executeValuesUnprepared: (sql, params) => Effect.map(run(sql, params, false), values),
      executeUnprepared: (sql, params, transformRows) => (transformRows ? Effect.map(run(sql, params, false), transformRows) : run(sql, params, false)),
      executeStream: () => Stream.die("executeStream is not supported by the node:sqlite driver"),
    } satisfies SqliteConnection;
  });

export const make = (config: SqliteConfig): Effect.Effect<Client.SqlClient, SqlError, Scope.Scope | Reactivity.Reactivity> =>
  Effect.gen(function* () {
    const connection = yield* makeConnection(config);
    const { acquirer, borrower, isTransaction, onCommitFailure, transactionAcquirer } = Client.makeSqliteAcquirers({
      connection: Effect.succeed(connection),
      semaphore: yield* Semaphore.make(1),
      isTransaction: (conn) => conn.isTransaction(),
    });
    return yield* Client.make({
      driver: "sqlite-node",
      acquirer,
      borrower,
      compiler: Statement.makeCompilerSqlite(),
      transactionAcquirer,
      onCommitFailure,
      isTransaction,
      releaseSavepoint: (name) => `RELEASE SAVEPOINT ${name}`,
      beginTransaction: "BEGIN IMMEDIATE",
      spanAttributes: [["db.system.name", "sqlite"]],
    });
  });

export const layer = (config: SqliteConfig): Layer.Layer<Client.SqlClient, SqlError> =>
  Layer.effect(Client.SqlClient, make(config)).pipe(Layer.provide(Reactivity.layer));
