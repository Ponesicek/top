/**
 * What happens in the daemon, for whoever is listening: the WebSocket connections (serve.ts) and the
 * tests. One PubSub carries every kind of event, so a listener sees them in the order they happened
 * (an entry before the summary that counts it, a bot's creation before its first entry).
 *
 * Publishing never waits: the bus is unbounded, and each listener keeps its own backlog (a client too
 * slow to keep up is dropped by its connection, which then resyncs on reconnect). Events are counted,
 * so a listener can tell when it has seen everything published up to a moment (see serve.ts).
 */
import type { AccountView, BotSummary, McpServerView, UpdateView } from "@top/protocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import type { Listing } from "./files.ts";
import type { StoredEntry } from "./store.ts";

export type DaemonEvent =
  /** A bot's transcript got an entry (also ones clients don't show, like system messages). */
  | { readonly _tag: "Entry"; readonly entry: StoredEntry }
  /** A bot's inbox changed: a message was queued, or the model took one. */
  | { readonly _tag: "Inbox"; readonly bot: number }
  /** A bot's summary changed, or a bot was made. */
  | { readonly _tag: "Bot"; readonly summary: BotSummary }
  | { readonly _tag: "BotRemoved"; readonly bot: number }
  /** A bot's files folder was listed (the first time, or after a change). */
  | { readonly _tag: "Files"; readonly bot: number; readonly folder: string; readonly listing: Listing }
  /** An MCP server was added or changed (settings, bots, state or tools). */
  | { readonly _tag: "McpServer"; readonly view: McpServerView }
  | { readonly _tag: "McpServerRemoved"; readonly id: number }
  /** What the bots' model requests are signed in with changed (see chatgpt.ts). */
  | { readonly _tag: "Account"; readonly view: AccountView }
  /** A permission request came or went (see permissions.ts). */
  | { readonly _tag: "Permissions" }
  /** The daemon's updates changed: a check, a download, a restart, or another channel (see updates.ts). */
  | { readonly _tag: "Update"; readonly view: UpdateView };

export class Events extends Context.Service<
  Events,
  {
    readonly publish: (event: DaemonEvent) => Effect.Effect<void>;
    /**
     * Every event from now on, until the scope closes, and how many were published before (to compare
     * with `published`: a listener that has taken `published - before` events has seen them all).
     */
    readonly subscribe: Effect.Effect<{ readonly subscription: PubSub.Subscription<DaemonEvent>; readonly before: number }, never, Scope.Scope>;
    /** How many events have been published so far. */
    readonly published: Effect.Effect<number>;
  }
>()("top/Events") {}

export const layer: Layer.Layer<Events> = Layer.effect(
  Events,
  Effect.gen(function* () {
    const pubsub = yield* Effect.acquireRelease(PubSub.unbounded<DaemonEvent>(), PubSub.shutdown);
    let count = 0;
    return Events.of({
      // Counted and published in one step, so `published` and the subscriptions always agree.
      publish: (event) =>
        Effect.sync(() => {
          count++;
          PubSub.publishUnsafe(pubsub, event);
        }),
      subscribe: Effect.map(PubSub.subscribe(pubsub), (subscription) => ({ subscription, before: count })),
      published: Effect.sync(() => count),
    });
  }),
);
