/**
 * Pretend updates, for trying the update button in `pnpm dev:fake` without a release, a packaged app or
 * an installed daemon: `?fakeUpdates=available` (both have one), `=server`, `=app`, `=current` (up to
 * date), `=fail` (the server's download fails), `=rollback` (the new server doesn't start). Nothing real
 * is checked, downloaded or restarted. Only in development builds: production has `undefined` here.
 */
import type { ConnectionStatus, UpdateView } from "@top/client";
import type { AppUpdates } from "./bridge.ts";
import type { ServerSide } from "./updateFlow.ts";

export type FakeUpdates = {
  readonly server: () => ServerSide;
  readonly app: () => AppUpdates;
  readonly subscribe: (listener: () => void) => () => void;
  readonly checkServer: () => Promise<void>;
  readonly installServer: (version: string) => Promise<void>;
  readonly checkApp: () => Promise<AppUpdates>;
  readonly installApp: () => Promise<AppUpdates>;
};

const NOTES = [
  "Keep the sidebar preview while a bot runs tools",
  "Ask for ChatGPT sign-in in a popup until the bots can answer",
  "Let the bot menu take clicks over the window's drag areas",
];

function makeFake(scenario: string): FakeUpdates {
  const listeners = new Set<() => void>();
  const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));
  const serverNext = "0.1.0-nightly.20261115.3";
  const appNext = "0.1.0-nightly.20261115.3";
  const offerServer = scenario !== "app" && scenario !== "current";
  const offerApp = scenario !== "server" && scenario !== "current";

  let version = "0.1.0-nightly.20261115.2";
  let connection: ConnectionStatus = "open";
  let update: UpdateView = {
    channel: "nightly",
    current: version,
    state: "idle",
    checkedAt: Date.now() - 4 * 60_000,
    ...(offerServer ? { available: { version: serverNext, notes: NOTES, url: "https://example.com" } } : {}),
  };
  let app: AppUpdates = {
    version: "0.1.0-nightly.20261115.2",
    channel: "nightly",
    state: "idle",
    checkedAt: Date.now() - 4 * 60_000,
    ...(offerApp ? { available: { version: appNext, notes: NOTES } } : {}),
  };
  // One object per change, so React sees a new snapshot only when something changed.
  let snapshot = { server: { version, update, connection } as ServerSide, app };
  const publish = () => {
    snapshot = { server: { version, update, connection }, app };
    for (const listener of listeners) listener();
  };
  const setServer = (change: Partial<UpdateView>) => {
    update = { ...update, ...change };
    publish();
  };
  const setApp = (change: Partial<AppUpdates>) => {
    app = { ...app, ...change };
    publish();
  };

  return {
    server: () => snapshot.server,
    app: () => snapshot.app,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    checkServer: async () => {
      setServer({ state: "checking" });
      await wait(900);
      setServer({ state: "idle", checkedAt: Date.now() });
    },
    installServer: async (target) => {
      if (update.state !== "idle" && update.state !== "failed") throw new Error("The server is already checking for or installing an update.");
      // Answered at once, like the daemon: the work goes on in the background.
      void (async () => {
        // A new try clears the last one's failure and rollback, as the daemon does.
        const { error: _error, rolledBack: _rolledBack, ...rest } = update;
        update = rest;
        setServer({ state: "downloading" });
        await wait(1800);
        if (scenario === "fail") return setServer({ state: "failed", error: "Couldn't download the update: connection reset (pretend)." });
        setServer({ state: "restarting" });
        await wait(500);
        connection = "reconnecting";
        publish();
        await wait(2200);
        if (scenario === "rollback") {
          connection = "open";
          // Like the daemon: it starts again on the old version, idle, and says what happened.
          return setServer({ state: "idle", rolledBack: target, error: `Top ${target} didn't start, so the server went back to ${version} (pretend).` });
        }
        version = target;
        connection = "open";
        const { available: _available, ...left } = update;
        update = { ...left, current: target, state: "idle", checkedAt: Date.now() };
        publish();
      })();
    },
    checkApp: async () => {
      setApp({ state: "checking" });
      await wait(700);
      setApp({ state: "idle", checkedAt: Date.now() });
      return app;
    },
    installApp: async () => {
      for (let progress = 0; progress <= 100; progress += 20) {
        setApp({ state: "downloading", progress });
        await wait(350);
      }
      setApp({ state: "installing" });
      // The real app quits here and starts the new one; pretend it came back.
      await wait(1500);
      const { available, progress: _progress, ...left } = app;
      app = { ...left, version: available?.version ?? app.version, state: "idle" };
      publish();
      return app;
    },
  };
}

const scenario = import.meta.env.DEV ? new URLSearchParams(location.search).get("fakeUpdates") : null;

export const fakeUpdates: FakeUpdates | undefined = scenario !== null ? makeFake(scenario || "available") : undefined;
