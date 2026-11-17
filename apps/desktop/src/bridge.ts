import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const FoundDaemon = Schema.Struct({
  device: Schema.String,
  url: Schema.String,
  self: Schema.Boolean,
  serverId: Schema.optionalKey(Schema.String),
  state: Schema.Literals(["ok", "refused"]),
  error: Schema.optionalKey(Schema.String),
});
export type FoundDaemon = typeof FoundDaemon.Type;

export const Discovery = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), daemons: Schema.Array(FoundDaemon) }),
  Schema.Struct({ ok: Schema.Literal(false), error: Schema.String }),
]);
export type Discovery = typeof Discovery.Type;

export const AppUpdates = Schema.Struct({
  version: Schema.String,
  channel: Schema.optionalKey(Schema.Literals(["stable", "nightly"])),
  state: Schema.Literals(["unavailable", "idle", "checking", "downloading", "installing", "failed"]),
  available: Schema.optionalKey(Schema.Struct({ version: Schema.String, notes: Schema.Array(Schema.String) })),
  progress: Schema.optionalKey(Schema.Number),
  checkedAt: Schema.optionalKey(Schema.Number),
  error: Schema.optionalKey(Schema.String),
});
export type AppUpdates = typeof AppUpdates.Type;

export const ContextMenuItem = Schema.Union([
  Schema.Struct({ separator: Schema.Literal(true) }),
  Schema.Struct({ action: Schema.String, label: Schema.optionalKey(Schema.String), enabled: Schema.Boolean }),
]);
export type ContextMenuItem = typeof ContextMenuItem.Type;

export const ContextMenu = Schema.Struct({ x: Schema.Number, y: Schema.Number, items: Schema.Array(ContextMenuItem) });
export type ContextMenu = typeof ContextMenu.Type;

export type TopDesktop = {
  readonly setZoomFactor: (factor: number) => void;
  readonly findTailnetDaemons: () => Promise<unknown>;
  readonly contextMenu: {
    readonly onOpen: (listener: (menu: unknown) => void) => () => void;
    readonly run: (action: string) => void;
  };
  readonly updates: {
    readonly state: () => Promise<unknown>;
    readonly check: () => Promise<unknown>;
    readonly install: () => Promise<unknown>;
    readonly setChannel: (channel: "stable" | "nightly") => Promise<unknown>;
    readonly onChange: (listener: (state: unknown) => void) => () => void;
  };
};

declare global {
  interface Window {
    readonly topDesktop?: TopDesktop;
  }
}

export const desktop: TopDesktop | undefined = window.topDesktop;

const decodeDiscovery = Schema.decodeUnknownPromise(Discovery);

export const findTailnetDaemons: (() => Promise<Discovery>) | undefined = desktop
  ? () => desktop.findTailnetDaemons().then((answer) => decodeDiscovery(answer))
  : undefined;

const decodeAppUpdates = Schema.decodeUnknownOption(AppUpdates);

export const appUpdates = desktop
  ? {
      state: () => desktop.updates.state().then((s) => Option.getOrUndefined(decodeAppUpdates(s))),
      check: () => desktop.updates.check(),
      install: () => desktop.updates.install(),
      setChannel: (channel: "stable" | "nightly") => desktop.updates.setChannel(channel),
      onChange: (listener: (state: AppUpdates) => void) =>
        desktop.updates.onChange((s) => Option.match(decodeAppUpdates(s), { onNone: () => {}, onSome: listener })),
    }
  : undefined;

const decodeContextMenu = Schema.decodeUnknownOption(ContextMenu);

export const contextMenu = desktop
  ? {
      onOpen: (listener: (menu: ContextMenu) => void) =>
        desktop.contextMenu.onOpen((m) => Option.match(decodeContextMenu(m), { onNone: () => {}, onSome: listener })),
      run: (action: string) => desktop.contextMenu.run(action),
    }
  : undefined;
