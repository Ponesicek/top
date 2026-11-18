import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterAll, test } from "vitest";
import * as Sqlite from "../src/sqlite.ts";
import * as Store from "../src/store.ts";
import { BEFORE_ASKS, BEFORE_CONTEXT_FILES } from "./harness.ts";

const dir = mkdtempSync(join(tmpdir(), "top-store-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const withStore = <A>(filename: string, use: (store: Store.Store["Service"]) => Effect.Effect<A>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* use(yield* Store.Store);
    }).pipe(Effect.provide(Store.layer.pipe(Layer.provide(Sqlite.layer({ filename }))))),
  );

test("bots from before icons could be picked keep the drawing of their name, and new ones keep their pick", async () => {
  const filename = join(dir, "top.sqlite");
  await withStore(filename, (store) => store.createBot("Atlas", "fake/model"));

  const db = new DatabaseSync(filename);
  db.exec(BEFORE_CONTEXT_FILES);
  db.exec("UPDATE bots SET description = 'Watches the build.', instructions = 'You are Atlas.'");
  db.exec("ALTER TABLE bots DROP COLUMN avatar; DROP TABLE permissions; DROP TABLE bot_skills; DELETE FROM effect_sql_migrations WHERE migration_id >= 2;");
  db.close();

  const bots = await withStore(filename, (store) =>
    Effect.gen(function* () {
      assert.deepEqual(yield* store.legacySouls, [{ bot: 1, name: "Atlas", description: "Watches the build." }]);
      yield* store.createBot("Lark", "fake/model", 42);
      assert.equal((yield* store.ask(1, "1:2:call_1", { kind: "permission", action: "deploy web" })).state, "pending");
      yield* store.enableSkills(1, ["pdf"], true);
      assert.deepEqual([...(yield* store.enabledSkills)], [[1, ["pdf"]]]);
      return yield* store.bots;
    }),
  );
  assert.deepEqual(
    bots.map((bot) => [bot.name, bot.avatar]),
    [
      ["Atlas", 0],
      ["Lark", 42],
    ],
  );
});

test("permission requests from before questions and secrets carry over: waiting ones stay answerable, and their cards and answers keep showing", async () => {
  const filename = join(dir, "asks.sqlite");
  await withStore(filename, (store) => store.createBot("Atlas", "fake/model"));

  const db = new DatabaseSync(filename);
  db.exec(BEFORE_ASKS);
  const permission = JSON.stringify({ request: 1, answer: "allowed" });
  const tool = (details: unknown) =>
    JSON.stringify({ role: "toolResult", toolCallId: "call_1", toolName: "collar__ask_permission", content: [], isError: false, details, timestamp: 1 });
  db.exec(`
    INSERT INTO permissions (id, bot, key, action, reason, state, at) VALUES (1, 1, '1:2:call_1', 'deploy web', 'It''s Friday.', 'allowed', 1);
    INSERT INTO permissions (id, bot, key, action, reason, state, at) VALUES (2, 1, '1:3:call_1', 'purge the cache', NULL, 'pending', 2);
    INSERT INTO entries (bot, kind, message, tool_call_id, at) VALUES (1, 'tool', '${tool({ permission: { id: 1, action: "deploy web", reason: "It's Friday." } }).replace(/'/g, "''")}', 'call_1', 3);
    INSERT INTO entries (bot, kind, message, tool_call_id, at) VALUES (1, 'tool', '${tool({ other: true })}', 'call_2', 3);
    INSERT INTO entries (bot, kind, message, at) VALUES (1, 'permission', '${permission}', 4);
    INSERT INTO entries (bot, kind, message, request_id, source, at) VALUES (1, 'user', '{"role":"user","content":"[Permission] The user allowed: deploy web.","timestamp":5}', 'permission:1', 'permission', 5);
    INSERT INTO inbox (bot, request_id, text, mode, source, at) VALUES (1, 'permission:9', '[Permission] The user denied: x.', 'steer', 'permission', 6);
  `);
  db.close();

  await withStore(filename, (store) =>
    Effect.gen(function* () {
      assert.deepEqual(
        (yield* store.waiting).map((row) => row.ask),
        [{ kind: "permission", id: 2, action: "purge the cache" }],
      );
      assert.deepEqual((yield* store.askedBy("1:2:call_1"))?.ask, { kind: "permission", id: 1, action: "deploy web", reason: "It's Friday." });
      const entries = yield* store.after(1, 0, 100);
      const [asked, other, answer, told] = entries;
      assert.equal(
        asked?.kind === "tool" && JSON.stringify(asked.message.details),
        JSON.stringify({ ask: { id: 1, action: "deploy web", reason: "It's Friday.", kind: "permission" } }),
      );
      assert.deepEqual(other?.kind === "tool" && other.message.details, { other: true });
      assert.deepEqual(answer?.kind === "answer" && answer.message, { request: 1, answer: "allowed" });
      assert.equal(told?.source, "answer");
      assert.equal((yield* store.inbox(1))[0]?.source, "answer");
      const next = yield* store.ask(1, "1:9:call_1", { kind: "question", question: "Which?", options: [] });
      assert.equal(next.ask.id, 3, "ids keep counting from the old requests");
    }),
  );
});
