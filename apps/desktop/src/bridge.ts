/**
 * What the desktop app's preload (electron/preload.cjs) gives the page as `window.topDesktop`. In a
 * browser there is none. Answers from the main process are checked here: main.js builds them from what
 * other devices on the tailnet said.
 */
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

/** `window.topDesktop`, as preload.cjs makes it. */
export type TopDesktop = {
  /** Zoom the whole window (0.5 to 3), as Ctrl+/Ctrl- does in a browser. */
  readonly setZoomFactor: (factor: number) => void;
  /** Ask this computer's Tailscale for Top daemons on the tailnet; the answer is unchecked (see `findTailnetDaemons`). */
  readonly findTailnetDaemons: () => Promise<unknown>;
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
