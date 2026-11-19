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
import { BEFORE_CONTEXT_FILES, BEFORE_TASKS } from "./harness.ts";

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
      assert.equal((yield* store.ask(1, "1:2:call_1", "deploy web", undefined)).state, "pending");
      yield* store.enableSkill(1, "pdf", true);
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

test("a database from before harness tasks gains their tables, keeps everything else, and purges them with their bot", async () => {
  const filename = join(dir, "before-tasks.sqlite");
  await withStore(filename, (store) =>
    Effect.gen(function* () {
      const bot = yield* store.createBot("Atlas", "fake/model");
      yield* store.append(bot, "notice", { text: "kept" });
    }),
  );
  const db = new DatabaseSync(filename);
  db.exec(BEFORE_TASKS);
  db.close();
  await withStore(filename, (store) =>
    Effect.gen(function* () {
      assert.equal((yield* store.bots).length, 1);
      assert.deepEqual(
        (yield* store.after(1, 0, 10)).map((e) => e.kind),
        ["notice"],
      );
      const session = yield* store.tasks.createSession({
        id: "ses_1",
        bot: 1,
        harness: "codex",
        location: "local",
        cwd: "/w",
        model: null,
        options: {},
        parent: null,
      });
      const task = yield* store.tasks.createTask({ id: "task_1", bot: 1, key: "k", session: session.id, title: "t", prompt: "p", images: [] }, "queued");
      yield* store.tasks.appendEvents([{ task: task.id, bot: 1, at: 1, kind: "state", text: "queued" }]);
      yield* store.tasks.addInput({ task: task.id, bot: 1, external: "q1", title: "x", questions: [] });
      yield* store.tasks.addMessage({ task: task.id, bot: 1, key: "m", mode: "queue", text: "more" });
      const again = yield* store.tasks.addInput({ task: task.id, bot: 1, external: "q1", title: "x", questions: [] });
      assert.equal(again.created, false, "one request per harness request id");
      assert.equal((yield* store.tasks.setState(task.id, ["queued"], "starting"))?.state, "starting");
      assert.equal(yield* store.tasks.setState(task.id, ["queued"], "running"), undefined, "a state change only applies from the state it expects");
      yield* store.markDeleted(1);
      yield* store.purgeBot(1);
      assert.equal(yield* store.tasks.task(task.id), undefined);
      assert.equal(yield* store.tasks.session(session.id), undefined);
    }),
  );
});
