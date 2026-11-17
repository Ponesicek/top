import { PermissionError, type PermissionRequest } from "@top/protocol";
import * as Effect from "effect/Effect";
import type { InboxRow, PermissionRow, Store, StoredEntry } from "./store.ts";

export type Permissions = {
  readonly waiting: Effect.Effect<PermissionRequest[]>;
  readonly ask: (bot: number, key: string, action: string, reason: string | undefined) => Effect.Effect<PermissionRow>;
  readonly askedBy: (key: string) => Effect.Effect<PermissionRow | undefined>;
  readonly answer: (id: number, bot: number, allow: boolean) => Effect.Effect<void, PermissionError>;
  readonly withdraw: (bot: number) => Effect.Effect<void>;
};

export type PermissionsEvents = {
  readonly entry: (entry: StoredEntry) => Effect.Effect<void>;
  readonly deliver: (row: InboxRow) => Effect.Effect<void>;
  readonly changed: (bot: number) => Effect.Effect<void>;
};

const NOT_WAITING = "That request was already answered, or isn't waiting anymore.";

export const requestOf = (row: PermissionRow): PermissionRequest => ({
  id: row.id,
  bot: row.bot,
  action: row.action,
  ...(row.reason ? { reason: row.reason } : {}),
});

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
