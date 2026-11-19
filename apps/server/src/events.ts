import type { AccountView, BotSummary, McpServerView, SkillsView, TaskView, UpdateView } from "@top/protocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import type { Listing } from "./files.ts";
import type { StoredEntry } from "./store.ts";

export type DaemonEvent =
  | { readonly _tag: "Entry"; readonly entry: StoredEntry }
  | { readonly _tag: "Inbox"; readonly bot: number }
  | { readonly _tag: "Bot"; readonly summary: BotSummary }
  | { readonly _tag: "BotRemoved"; readonly bot: number }
  | { readonly _tag: "Files"; readonly bot: number; readonly folder: string; readonly listing: Listing }
  | { readonly _tag: "McpServer"; readonly view: McpServerView }
  | { readonly _tag: "McpServerRemoved"; readonly id: number }
  | { readonly _tag: "Skills"; readonly view: SkillsView }
  | { readonly _tag: "Account"; readonly view: AccountView }
  | { readonly _tag: "Asks" }
  | { readonly _tag: "Tasks"; readonly views: readonly TaskView[] }
  | { readonly _tag: "Update"; readonly view: UpdateView };

export class Events extends Context.Service<
  Events,
  {
    readonly publish: (event: DaemonEvent) => Effect.Effect<void>;
    readonly subscribe: Effect.Effect<{ readonly subscription: PubSub.Subscription<DaemonEvent>; readonly before: number }, never, Scope.Scope>;
    readonly published: Effect.Effect<number>;
  }
>()("top/Events") {}

export const layer: Layer.Layer<Events> = Layer.effect(
  Events,
  Effect.gen(function* () {
    const pubsub = yield* Effect.acquireRelease(PubSub.unbounded<DaemonEvent>(), PubSub.shutdown);
    let count = 0;
    return Events.of({
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
