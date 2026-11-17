/**
 * Permission requests: a bot asks the user whether it may do something (Collar's `ask_permission`),
 * and waits for the answer.
 *
 * - A request lives in memory only, while the tool call that made it waits. It ends when a client
 *   answers it, or when the call stops waiting (the user's Stop, a deleted bot, a stopped job). A
 *   restart ends it unanswered: the bot is told nobody answered, and the request is never asked again.
 * - Each has its own id, and names the bot that asked. An answer must name both; the first one wins,
 *   and any later one (another device, a double click, an old screen) is refused.
 * - It only carries the question and the answer back. Nothing else is gated on it.
 */
import { randomUUID } from "node:crypto";
import { PermissionError, type PermissionRequest } from "@top/protocol";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

export type Permissions = {
  /** Every request waiting for an answer, oldest first. */
  readonly pending: () => PermissionRequest[];
  /**
   * Ask, and wait for the answer: `true` allowed, `false` denied. Interrupting the wait (the call's
   * signal) withdraws the request.
   */
  readonly ask: (bot: number, toolCallId: string, action: string, reason: string | undefined) => Effect.Effect<boolean>;
  /** A client's answer. Fails when the request isn't waiting (answered already, withdrawn) or isn't that bot's. */
  readonly answer: (id: string, bot: number, allow: boolean) => Effect.Effect<void, PermissionError>;
};

const NOT_WAITING = "That request was already answered, or isn't waiting anymore.";

/** `changed` runs whenever a request comes or goes, so clients can be sent the new list. */
export function makePermissions(changed: Effect.Effect<void>): Permissions {
  const waiting = new Map<string, { readonly request: PermissionRequest; readonly answer: Deferred.Deferred<boolean> }>();
  return {
    pending: () => [...waiting.values()].map((entry) => entry.request),
    ask: (bot, toolCallId, action, reason) =>
      Effect.gen(function* () {
        const request: PermissionRequest = { id: randomUUID(), bot, toolCallId, action, ...(reason ? { reason } : {}) };
        const answer = yield* Deferred.make<boolean>();
        waiting.set(request.id, { request, answer });
        yield* changed;
        return yield* Deferred.await(answer).pipe(
          Effect.ensuring(
            Effect.suspend(() => {
              // Answered (and removed by `answer`) or withdrawn: either way it no longer waits.
              if (!waiting.delete(request.id)) return Effect.void;
              return changed;
            }),
          ),
        );
      }),
    answer: (id, bot, allow) =>
      Effect.suspend(() => {
        const entry = waiting.get(id);
        if (!entry || entry.request.bot !== bot) return Effect.fail(new PermissionError({ message: NOT_WAITING }));
        // Removed before anything else can run: a second answer finds nothing.
        waiting.delete(id);
        Deferred.doneUnsafe(entry.answer, Effect.succeed(allow));
        return changed;
      }),
  };
}
