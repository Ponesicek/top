/**
 * Permission requests: a bot asks the user whether it may do something (Collar's `ask_permission`).
 *
 * - Asking doesn't make the bot wait. The request is saved (`permissions` in store.ts) and the call's
 *   result says so; the bot carries on, and answers other messages meanwhile.
 * - A request waits until a client answers it, or the user's Stop withdraws it. It outlives a daemon
 *   restart: the bot asked once, and the answer still reaches it.
 * - Settling one appends a `permission` entry naming it: what clients show, also after a reload or on
 *   another device. An answer also queues one message for the bot, in the same transaction, so it
 *   arrives once. A withdrawal sends none: the user stopped the bot, and a message would start it again.
 * - The first answer wins; a later one (another device, a double click, an old screen), or one naming
 *   another bot, is refused.
 * - It only carries the question and the answer back. Nothing else is gated on it.
 */
import { PermissionError, type PermissionRequest } from "@top/protocol";
import * as Effect from "effect/Effect";
import type { InboxRow, PermissionRow, Store, StoredEntry } from "./store.ts";

export type Permissions = {
  /** Every request waiting for an answer, oldest first. */
  readonly waiting: Effect.Effect<PermissionRequest[]>;
  /** Ask, as the tool call named by `key`. The same call asks once: again, it gets the same request. */
  readonly ask: (bot: number, key: string, action: string, reason: string | undefined) => Effect.Effect<PermissionRow>;
  /** The request a tool call made, if it got as far as asking (for a call a restart cut off). */
  readonly askedBy: (key: string) => Effect.Effect<PermissionRow | undefined>;
  /** A client's answer. Fails when the request isn't waiting (answered already, withdrawn) or isn't that bot's. */
  readonly answer: (id: number, bot: number, allow: boolean) => Effect.Effect<void, PermissionError>;
  /** The user's Stop: the bot's waiting requests are withdrawn. */
  readonly withdraw: (bot: number) => Effect.Effect<void>;
};

export type PermissionsEvents = {
  /** An entry was appended (a request settled). */
  readonly entry: (entry: StoredEntry) => Effect.Effect<void>;
  /** A message was queued for its bot (an answer). */
  readonly deliver: (row: InboxRow) => Effect.Effect<void>;
  /** The waiting requests changed: `bot`'s came or went. */
  readonly changed: (bot: number) => Effect.Effect<void>;
};

const NOT_WAITING = "That request was already answered, or isn't waiting anymore.";

export const requestOf = (row: PermissionRow): PermissionRequest => ({
  id: row.id,
  bot: row.bot,
  action: row.action,
  ...(row.reason ? { reason: row.reason } : {}),
});

/** What the bot is told when the user answers. */
const answerText = (allow: boolean, action: string) =>
  allow ? `[Permission] The user allowed: ${action}.` : `[Permission] The user denied: ${action}. Don't do it.`;

export function makePermissions(store: Store["Service"], events: PermissionsEvents): Permissions {
  const waiting = Effect.map(store.waiting, (rows) => rows.map(requestOf));
  const announce = events.changed;

  const settle = (bot: number, id: number, answer: "allowed" | "denied" | "withdrawn", text?: string) =>
    Effect.gen(function* () {
      const settled = yield* store.settle(bot, id, answer, text);
      if (!settled) return false;
      yield* events.entry(settled.entry);
      if (settled.message) yield* events.deliver(settled.message);
      return true;
    });

  return {
    waiting,
    ask: (bot, key, action, reason) =>
      Effect.gen(function* () {
        const row = yield* store.ask(bot, key, action, reason);
        if (row.state === "pending") yield* announce(bot);
        return row;
      }),
    askedBy: store.askedBy,
    answer: (id, bot, allow) =>
      Effect.gen(function* () {
        const row = (yield* store.waitingOf(bot)).find((r) => r.id === id);
        // The update in `settle` decides: of two answers at once, only one finds it still waiting.
        if (!row || !(yield* settle(bot, id, allow ? "allowed" : "denied", answerText(allow, row.action))))
          return yield* new PermissionError({ message: NOT_WAITING });
        yield* announce(bot);
      }),
    withdraw: (bot) =>
      Effect.gen(function* () {
        const rows = yield* store.waitingOf(bot);
        if (!rows.length) return;
        for (const row of rows) yield* settle(bot, row.id, "withdrawn");
        yield* announce(bot);
      }),
  };
}
