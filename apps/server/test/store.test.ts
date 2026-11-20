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
import { BEFORE_ASKS, BEFORE_CONTEXT_FILES, BEFORE_TASKS, harness } from "./harness.ts";

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

test("bots are listed in the order they were made until someone reorders them; the order outlasts a restart and a bot made later goes last", async () => {
  const filename = join(dir, "order.sqlite");
  const names = (bots: readonly Store.BotRow[]) => bots.map((bot) => bot.name);
  const ids = await withStore(filename, (store) =>
    Effect.gen(function* () {
      const made = [
        yield* store.createBot("Atlas", "fake/model"),
        yield* store.createBot("Juniper", "fake/model"),
        yield* store.createBot("Moss", "fake/model"),
      ];
      assert.deepEqual(names(yield* store.bots), ["Atlas", "Juniper", "Moss"], "creation order, nothing rewritten");
      return made;
    }),
  );
  const db = new DatabaseSync(filename);
  assert.deepEqual(
    db
      .prepare("SELECT position FROM bots ORDER BY id")
      .all()
      .map((row) => row.position),
    [null, null, null],
    "the new column leaves existing bots alone",
  );
  db.close();

  await withStore(filename, (store) =>
    Effect.gen(function* () {
      yield* store.setBotOrder([ids[2]!, ids[0]!, ids[1]!]);
      assert.deepEqual(names(yield* store.bots), ["Moss", "Atlas", "Juniper"]);
      yield* store.createBot("Quill", "fake/model");
      assert.deepEqual(names(yield* store.bots), ["Moss", "Atlas", "Juniper", "Quill"], "a bot made after a reorder goes last");
    }),
  );
  assert.deepEqual(await withStore(filename, (store) => Effect.map(store.bots, names)), ["Moss", "Atlas", "Juniper", "Quill"], "kept across a restart");
});

test("reordering bots from a client: the daemon lists them so at once, skips ids it doesn't know, keeps any left out after the rest, and starts with that order", async () => {
  const h = await harness({ bots: ["Atlas", "Juniper", "Moss", "Quill"] });
  const [atlas, juniper, moss, quill] = h.bots as [number, number, number, number];
  const names = () => h.daemon.bots().map((bot) => bot.name);
  assert.deepEqual(names(), ["Atlas", "Juniper", "Moss", "Quill"]);
  const before = await h.run(h.events.published);
  await h.run(h.daemon.setBotOrder([quill, 999, moss, quill]));
  assert.deepEqual(names(), ["Quill", "Moss", "Atlas", "Juniper"]);
  assert.ok((await h.run(h.events.published)) > before, "every client is told");
  await h.run(h.daemon.setBotOrder([juniper, atlas, moss, quill]));
  await h.close();
  const again = await harness({ dir: h.dir });
  assert.deepEqual(
    again.daemon.bots().map((bot) => bot.name),
    ["Juniper", "Atlas", "Moss", "Quill"],
  );
  await again.close();
});

test("a reorder racing a delete or a new bot keeps the roster whole: the deleted bot stays gone, the new one stays, last", async () => {
  // The order's write takes a moment, so the delete and the new bot land while it's being saved.
  const slow = (store: Store.Store["Service"]): Store.Store["Service"] => ({
    ...store,
    setBotOrder: (ids) => Effect.andThen(Effect.sleep("30 millis"), store.setBotOrder(ids)),
  });
  const h = await harness({ bots: ["Atlas", "Juniper", "Moss"], store: slow });
  const [atlas, juniper, moss] = h.bots as [number, number, number];
  const names = () => h.daemon.bots().map((bot) => bot.name);
  await h.run(Effect.all([h.daemon.setBotOrder([moss, juniper, atlas]), h.daemon.deleteBot(juniper)], { concurrency: "unbounded" }));
  assert.deepEqual(names(), ["Moss", "Atlas"]);
  const [, made] = await h.run(Effect.all([h.daemon.setBotOrder([atlas, moss]), h.daemon.createBot("Quill", "")], { concurrency: "unbounded" }));
  assert.deepEqual(names(), ["Atlas", "Moss", "Quill"]);
  assert.ok(h.daemon.bots().some((bot) => bot.id === made));
  await h.close();
  const again = await harness({ dir: h.dir });
  assert.deepEqual(
    again.daemon.bots().map((bot) => bot.name),
    ["Atlas", "Moss", "Quill"],
    "and the store agrees after a restart",
  );
  await again.close();
});
