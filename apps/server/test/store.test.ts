/**
 * Upgrading data from an earlier version: the daemon's SQLite file outlives the build that wrote it.
 */
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
  await withStore(filename, (store) => store.createBot("Atlas", "You are Atlas.", "fake/model", "Watches the build."));

  // Back to the file a build without `2_bot_avatar` left: no avatar column, and neither it nor a later migration run.
  const db = new DatabaseSync(filename);
  db.exec("ALTER TABLE bots DROP COLUMN avatar; DROP TABLE permissions; DELETE FROM effect_sql_migrations WHERE migration_id >= 2;");
  db.close();

  const bots = await withStore(filename, (store) =>
    Effect.gen(function* () {
      yield* store.createBot("Lark", "You are Lark.", "fake/model", "", 42);
      // `3_permissions` ran too.
      assert.equal((yield* store.ask(1, "1:2:call_1", "deploy web", undefined)).state, "pending");
      return yield* store.bots;
    }),
  );
  assert.deepEqual(
    bots.map((bot) => [bot.name, bot.description, bot.avatar]),
    [
      ["Atlas", "Watches the build.", 0],
      ["Lark", "", 42],
    ],
  );
});
