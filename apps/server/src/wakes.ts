/**
 * Wake-ups: a bot asks to be woken later (Collar's `wake`), and when it's due, the note it left comes
 * to it as a message (an inbox row with source `wake`), which starts a task if the bot was idle or
 * waits for the end of the one running.
 *
 * Wake-ups live in the store, so they survive restarts: one that came due while the daemon was down
 * goes off as soon as it starts, saying how late it is. A timer is set for the soonest one only, and
 * set again whenever wake-ups change.
 */
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import { type InboxRow, Store, type WakeRow } from "./store.ts";
import { duration, localTime } from "./time.ts";

/** Sleeps this long or longer are cut to this and the clock looks again. */
const MAX_WAIT_MS = 60 * 60 * 1000;
/** A wake-up this much later than due says so. */
const LATE_MS = 60 * 1000;
/** After a wake-up couldn't be delivered, wait at least this long before trying again. */
const RETRY_MS = 5_000;

/** The message a wake-up brings. */
export function wakeText(wake: WakeRow, now: number): string {
  const lines = [`[Wake-up] ${wake.note}`, "", `You set this wake-up at ${localTime(wake.createdAt)} for ${localTime(wake.dueAt)}. The user didn't send it.`];
  if (now - wake.dueAt > LATE_MS) lines.push(`It's ${localTime(now)} now, ${duration(now - wake.dueAt)} late: the daemon wasn't running when it was due.`);
  return lines.join("\n");
}

export type WakeClock = {
  /** Begin firing wake-ups, those already due first. After the bots have started. */
  readonly start: Effect.Effect<void>;
  /** Wake-ups were added or removed: look at the soonest one again. */
  readonly changed: Effect.Effect<void>;
};

/** The clock that fires wake-ups, running in the scope it's made in. `deliver` hands a fired one's message to its bot. */
export const makeWakeClock = Effect.fnUntraced(function* (deliver: (row: InboxRow) => Effect.Effect<void>) {
  const store = yield* Store;
  const scope = yield* Effect.scope;
  const changes = yield* Queue.sliding<void>(1);

  /** Fire every due wake-up; true if one couldn't be delivered. */
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
  });

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
