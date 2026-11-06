/**
 * Wake-ups: a bot asks to be woken later (Collar's `wake`), and when it's due, the note it left comes
 * to it as a message (an inbox row with source `wake`), which starts a task if the bot was idle or
 * waits for the end of the one running.
 *
 * Wake-ups live in the store, so they survive restarts: one that came due while the daemon was down
 * goes off as soon as it starts, saying how late it is. A timer is set for the soonest one only, and
 * set again whenever wake-ups change.
 */
import type { InboxRow, Store, WakeRow } from "./store.ts";
import { duration, localTime } from "./time.ts";

/** Timers this long or longer are set to this and checked again (Node's limit is about 24.8 days). */
const MAX_TIMER_MS = 60 * 60 * 1000;
/** A wake-up this much later than due says so. */
const LATE_MS = 60 * 1000;

/** The message a wake-up brings. */
export function wakeText(wake: WakeRow, now: number): string {
  const lines = [`[Wake-up] ${wake.note}`, "", `You set this wake-up at ${localTime(wake.createdAt)} for ${localTime(wake.dueAt)}. The user didn't send it.`];
  if (now - wake.dueAt > LATE_MS) lines.push(`It's ${localTime(now)} now, ${duration(now - wake.dueAt)} late: the daemon wasn't running when it was due.`);
  return lines.join("\n");
}

export class WakeClock {
  readonly #store: Store;
  readonly #deliver: (row: InboxRow) => void;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running = false;

  constructor(store: Store, deliver: (row: InboxRow) => void) {
    this.#store = store;
    this.#deliver = deliver;
  }

  /** Begin firing wake-ups, those already due first. After the bots have started. */
  start() {
    this.#running = true;
    this.#fire();
  }

  /** Wake-ups were added or removed: aim the timer again. */
  changed() {
    if (this.#running) this.#arm();
  }

  close() {
    this.#running = false;
    clearTimeout(this.#timer);
  }

  /** `atLeast`: after a failure, so a wake-up that can't be delivered isn't retried in a tight loop. */
  #arm(atLeast = 0) {
    clearTimeout(this.#timer);
    const next = this.#store.nextWakeAt();
    if (next === undefined) return;
    this.#timer = setTimeout(() => this.#fire(), Math.min(Math.max(atLeast, next - Date.now()), MAX_TIMER_MS));
    this.#timer.unref?.();
  }

  #fire() {
    if (!this.#running) return;
    const now = Date.now();
    let failed = false;
    for (const wake of this.#store.dueWakes(now)) {
      try {
        const row = this.#store.fireWake(wake, wakeText(wake, now));
        if (row) this.#deliver(row);
      } catch (error) {
        console.error(`[top] wake-up ${wake.id}:`, error);
        failed = true;
      }
    }
    this.#arm(failed ? 5_000 : 0);
  }
}
