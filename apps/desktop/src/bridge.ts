/**
 * What the desktop app's preload (electron/preload.cjs) gives the page as `window.topDesktop`. In a
 * browser there is none. Answers from the main process are checked here: main.js builds them from what
 * other devices on the tailnet said.
 */
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** A Top daemon found on the tailnet. */
export const FoundDaemon = Schema.Struct({
  device: Schema.String,
  url: Schema.String,
  /** On this computer. */
  self: Schema.Boolean,
  serverId: Schema.optionalKey(Schema.String),
  /** `refused`: there's a Top, but it doesn't let this device in. */
  state: Schema.Literals(["ok", "refused"]),
  error: Schema.optionalKey(Schema.String),
});
export type FoundDaemon = typeof FoundDaemon.Type;

export const Discovery = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), daemons: Schema.Array(FoundDaemon) }),
  Schema.Struct({ ok: Schema.Literal(false), error: Schema.String }),
]);
export type Discovery = typeof Discovery.Type;

/** The app's own updates, as electron/updates.js reports them. `unavailable`: this app doesn't update itself (run from a checkout). */
export const AppUpdates = Schema.Struct({
  version: Schema.String,
  /** The releases the app follows; absent from a checkout. */
  channel: Schema.optionalKey(Schema.Literals(["stable", "nightly"])),
  state: Schema.Literals(["unavailable", "idle", "checking", "downloading", "installing", "failed"]),
  available: Schema.optionalKey(Schema.Struct({ version: Schema.String, notes: Schema.Array(Schema.String) })),
  /** Percent downloaded. */
  progress: Schema.optionalKey(Schema.Number),
  checkedAt: Schema.optionalKey(Schema.Number),
  error: Schema.optionalKey(Schema.String),
});
export type AppUpdates = typeof AppUpdates.Type;

/** One row of the right-click menu (see electron/context-menu.js): an action to send back, or a separator. */
export const ContextMenuItem = Schema.Union([
  Schema.Struct({ separator: Schema.Literal(true) }),
  Schema.Struct({ action: Schema.String, label: Schema.optionalKey(Schema.String), enabled: Schema.Boolean }),
]);
export type ContextMenuItem = typeof ContextMenuItem.Type;

/** A right-click's menu, at the click in CSS pixels. */
export const ContextMenu = Schema.Struct({ x: Schema.Number, y: Schema.Number, items: Schema.Array(ContextMenuItem) });
export type ContextMenu = typeof ContextMenu.Type;

/** `window.topDesktop`, as preload.cjs makes it. */
export type TopDesktop = {
  /** Zoom the whole window (0.5 to 3), as Ctrl+/Ctrl- does in a browser. */
  readonly setZoomFactor: (factor: number) => void;
  /** Ask this computer's Tailscale for Top daemons on the tailnet; the answer is unchecked (see `findTailnetDaemons`). */
  readonly findTailnetDaemons: () => Promise<unknown>;
  /** The right-click menu: each right-click's menu (unchecked: see `contextMenu`), and the action picked from it. */
  readonly contextMenu: {
    readonly onOpen: (listener: (menu: unknown) => void) => () => void;
    readonly run: (action: string) => void;
  };
  /** The app's own updates; every answer is the state after it (unchecked: see `appUpdates`). */
  readonly updates: {
    readonly state: () => Promise<unknown>;
    readonly check: () => Promise<unknown>;
    /** Download the available version, then quit and start it. */
    readonly install: () => Promise<unknown>;
    readonly setChannel: (channel: "stable" | "nightly") => Promise<unknown>;
    /** Called with each new state; returns the unsubscribe. */
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

/** The daemons on the tailnet; `undefined` outside the desktop app. */
export const findTailnetDaemons: (() => Promise<Discovery>) | undefined = desktop
  ? () => desktop.findTailnetDaemons().then((answer) => decodeDiscovery(answer))
  : undefined;

const decodeAppUpdates = Schema.decodeUnknownOption(AppUpdates);

/** The app's own updates, checked; `undefined` outside the desktop app. */
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

/** The right-click menu Electron asks the page to draw; `undefined` in a browser, which has its own. */
export const contextMenu = desktop
  ? {
      onOpen: (listener: (menu: ContextMenu) => void) =>
        desktop.contextMenu.onOpen((m) => Option.match(decodeContextMenu(m), { onNone: () => {}, onSome: listener })),
      run: (action: string) => desktop.contextMenu.run(action),
    }
  : undefined;
