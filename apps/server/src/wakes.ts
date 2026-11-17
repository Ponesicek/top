import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import { type InboxRow, Store, type WakeRow } from "./store.ts";
import { duration, localTime } from "./time.ts";

const MAX_WAIT_MS = 60 * 60 * 1000;
const LATE_MS = 60 * 1000;
const RETRY_MS = 5_000;

export function wakeText(wake: WakeRow, now: number): string {
  const lines = [`[Wake-up] ${wake.note}`, "", `You set this wake-up at ${localTime(wake.createdAt)} for ${localTime(wake.dueAt)}. The user didn't send it.`];
  if (now - wake.dueAt > LATE_MS) lines.push(`It's ${localTime(now)} now, ${duration(now - wake.dueAt)} late: the daemon wasn't running when it was due.`);
  return lines.join("\n");
}

export type WakeClock = {
  readonly start: Effect.Effect<void>;
  readonly changed: Effect.Effect<void>;
};

export const makeWakeClock = Effect.fnUntraced(function* (deliver: (row: InboxRow) => Effect.Effect<void>) {
  const store = yield* Store;
  const scope = yield* Effect.scope;
  const changes = yield* Queue.sliding<void>(1);

  const fire = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    let failed = false;
    for (const wake of yield* store.dueWakes(now)) {
      yield* store.fireWake(wake, wakeText(wake, now)).pipe(
        Effect.flatMap((row) => (row ? deliver(row) : Effect.void)),
        Effect.catchCause((cause) =>
          Effect.logError(`wake-up ${wake.id}`, cause).pipe(
            Effect.andThen(
              Effect.sync(() => {
                failed = true;
              }),
            ),
          ),
        ),
      );
    }
    return failed;
  }).pipe(Effect.withSpan("WakeClock.fire"));

  const loop = Effect.gen(function* () {
    for (;;) {
      const failed = yield* fire;
      const next = yield* store.nextWakeAt;
      const now = yield* Clock.currentTimeMillis;
      const wait = next === undefined ? undefined : Math.min(Math.max(failed ? RETRY_MS : 0, next - now), MAX_WAIT_MS);
      const changed = Queue.take(changes);
      yield* wait === undefined ? changed : Effect.raceFirst(Effect.sleep(Duration.millis(wait)), changed);
    }
  });

  const clock: WakeClock = {
    start: Effect.asVoid(Effect.forkIn(loop, scope)),
    changed: Effect.asVoid(Queue.offer(changes, undefined)),
  };
  return clock;
});
