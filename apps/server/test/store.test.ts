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
import { BEFORE_CONTEXT_FILES } from "./harness.ts";

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
