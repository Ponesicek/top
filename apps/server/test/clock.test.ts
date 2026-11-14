/**
 * Waiting, on Effect's test clock: wake-ups and background jobs keep time with Effect's Clock, so these
 * run hours of it in an instant, and exactly. (The daemon tests in await.test.ts drive pi's model,
 * which runs on real timers, so they keep real time.)
 */
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";
import Type from "typebox";
import { makeJobs } from "../src/jobs.ts";
import * as Sqlite from "../src/sqlite.ts";
import * as Store from "../src/store.ts";
import { type InboxRow, Store as StoreService } from "../src/store.ts";
import { sleep, type TopTool, text } from "../src/tools.ts";
import { makeWakeClock } from "../src/wakes.ts";

const store = Store.layer.pipe(Layer.provide(Sqlite.layer({ filename: ":memory:" })));

/** A bot, and the messages Top queues for it. */
const setup = Effect.gen(function* () {
  const store = yield* StoreService;
  const bot = yield* store.createBot("Atlas", "", "fake/model");
  const delivered: InboxRow[] = [];
  const deliver = (row: InboxRow) =>
    Effect.sync(() => {
      delivered.push(row);
    });
  return { store, bot, delivered, deliver };
});

/** Let forked fibers run what the clock allows. */
const settle = Effect.yieldNow.pipe(Effect.repeat({ times: 20 }));

/** A tool that takes `minutes` of the clock, or stops when its signal says so. */
const slow = (minutes: number): TopTool => ({
  name: "slow__tool",
  label: "Slow",
  description: "",
  parameters: Type.Object({}),
  run: (_args, ctx) => Effect.as(sleep(minutes * 60_000, ctx.signal), text(`done after ${minutes} min`)),
});

describe("wake-ups", () => {
  it.effect("one set for three hours from now goes off after three hours, not before", () =>
    Effect.gen(function* () {
      const { store, bot, delivered, deliver } = yield* setup;
      yield* store.addWake(bot, "k", 3 * 60 * 60_000, "check the deploy");
      const clock = yield* makeWakeClock(deliver);
      yield* clock.start;
      yield* settle;

      // Longer than the clock sleeps at once (an hour): it looks again, and waits on.
      yield* TestClock.adjust("2 hours");
      yield* settle;
      yield* TestClock.adjust("59 minutes");
      yield* settle;
      assert.deepStrictEqual(delivered, [], "not before it's due");

      yield* TestClock.adjust("1 minute");
      yield* settle;
      assert.strictEqual(delivered.length, 1);
      assert.match(delivered[0]!.text, /^\[Wake-up\] check the deploy\n/);
      assert.notMatch(delivered[0]!.text, /late/, "on time");
    }).pipe(Effect.scoped, Effect.provide(store)),
  );

  it.effect("a sooner one set while the clock waits goes off first", () =>
    Effect.gen(function* () {
      const { store, bot, delivered, deliver } = yield* setup;
      yield* store.addWake(bot, "later", 60 * 60_000, "later");
      const clock = yield* makeWakeClock(deliver);
      yield* clock.start;
      yield* settle;

      yield* store.addWake(bot, "sooner", 10 * 60_000, "sooner");
      yield* clock.changed;
      yield* TestClock.adjust("10 minutes");
      yield* settle;
      assert.deepStrictEqual(
        delivered.map((row) => row.text.split("\n")[0]),
        ["[Wake-up] sooner"],
      );
    }).pipe(Effect.scoped, Effect.provide(store)),
  );
});

describe("background jobs", () => {
  it.effect("a call that ends within the limit is its own result; a longer one moves on at exactly the limit", () =>
    Effect.gen(function* () {
      const { bot, delivered, deliver } = yield* setup;
      const jobs = yield* makeJobs({ deliver, changed: () => Effect.void }, 30_000);

      const quick = yield* Effect.forkChild(jobs.wrap(slow(0.25)).run({}, { key: "k1", bot }));
      yield* TestClock.adjust("15 seconds");
      assert.deepStrictEqual((yield* Fiber.join(quick)).content, [{ type: "text", text: "done after 0.25 min" }]);

      const long = yield* Effect.forkChild(jobs.wrap(slow(5)).run({}, { key: "k2", bot }));
      yield* TestClock.adjust("29 seconds");
      yield* settle;
      assert.isUndefined(long.pollUnsafe(), "still waiting at 29 s");
      yield* TestClock.adjust("1 second");
      const moved = yield* Fiber.join(long);
      assert.match((moved.content[0] as { text: string }).text, /^Still running after 30s, so it moved to the background as job 1/);

      yield* TestClock.adjust("5 minutes");
      yield* settle;
      assert.strictEqual(delivered.length, 1);
      assert.match(delivered[0]!.text, /^\[Background job 1 finished\] slow__tool, after 5m/);
      assert.match(delivered[0]!.text, /done after 5 min/);
    }).pipe(Effect.scoped, Effect.provide(store)),
  );

  it.effect("a job past its time is stopped, and the bot is told it timed out", () =>
    Effect.gen(function* () {
      const { store, bot, delivered, deliver } = yield* setup;
      const jobs = yield* makeJobs({ deliver, changed: () => Effect.void }, 30_000);

      const started = yield* Effect.forkChild(
        jobs.run(slow(24 * 60), {}, { key: "k", bot }, { foregroundMs: 0, stopAfterMs: 10 * 60_000, note: "nightly build" }),
      );
      // Even started straight in the background, a call gets a second to fail or end.
      yield* TestClock.adjust("1 second");
      assert.match(((yield* Fiber.join(started)).content[0] as { text: string }).text, /^Started as background job 1 .*stopped if it's still running 10m/);

      yield* TestClock.adjust("9 minutes");
      yield* settle;
      assert.deepStrictEqual(delivered, []);
      yield* TestClock.adjust("1 minute");
      yield* settle;
      assert.strictEqual(delivered.length, 1);
      assert.match(delivered[0]!.text, /^\[Background job 1 timed out\] nightly build: slow__tool: stopped after 10m/);
      assert.match(delivered[0]!.text, /Stopped/, "with what the job came to");
      assert.strictEqual((yield* store.job(1))?.state, "stopped");
    }).pipe(Effect.scoped, Effect.provide(store)),
  );
});
