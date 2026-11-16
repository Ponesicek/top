/**
 * Updates as the UI sees them: the server's (from the daemon, through the client) and this app's own
 * (from electron/updates.js). Each follows a channel of its own: one server has many devices.
 *
 * Nothing installs until the user presses Update (the sidebar's update button, or Settings → Updates).
 */
import { type Channel, type ConnectionStatus, channelName, type UpdateView } from "@top/client";
import { useEffect, useState, useSyncExternalStore } from "react";
import { type AppUpdates, appUpdates } from "./bridge.ts";
import { fakeUpdates } from "./devUpdates.ts";
import { top, useClient } from "./top.ts";
import { installBoth, type UpdateDeps, type UpdateJob, type UpdatePlan } from "./updateFlow.ts";

// ── this app ─────────────────────────────────────────────────────────────────────

let appState: AppUpdates | undefined;
const appListeners = new Set<() => void>();
const publishApp = (state: AppUpdates | undefined) => {
  appState = state;
  for (const listener of appListeners) listener();
};
if (appUpdates) {
  void appUpdates.state().then(publishApp);
  appUpdates.onChange(publishApp);
}

/** This app's updates; `undefined` outside the desktop app (or until it answers). */
export function useAppUpdates(): AppUpdates | undefined {
  return useSyncExternalStore(
    (listener) => {
      appListeners.add(listener);
      return () => appListeners.delete(listener);
    },
    () => appState,
  );
}

// ── where updates come from ─────────────────────────────────────────────────────

/** The server's and this app's updaters: the real ones, or in development the pretend ones of `?fakeUpdates`. */
export const sources = fakeUpdates
  ? {
      checkServer: fakeUpdates.checkServer,
      installServer: fakeUpdates.installServer,
      checkApp: fakeUpdates.checkApp,
      installApp: fakeUpdates.installApp as (() => Promise<AppUpdates | undefined>) | undefined,
    }
  : {
      checkServer: () => top.checkForUpdate(),
      installServer: (version: string) => top.installUpdate(version),
      checkApp: appUpdates?.check,
      installApp: appUpdates ? () => appUpdates!.install().then(() => appUpdates!.state()) : undefined,
    };

const flowDeps: UpdateDeps = fakeUpdates
  ? { server: fakeUpdates.server, subscribe: fakeUpdates.subscribe, installServer: sources.installServer, installApp: sources.installApp }
  : {
      server: () => {
        const snapshot = top.getSnapshot();
        return { version: snapshot.server?.version, update: snapshot.update, connection: snapshot.connection };
      },
      subscribe: top.subscribe,
      installServer: sources.installServer,
      installApp: sources.installApp,
    };

// ── the update the user started ──────────────────────────────────────────────────

let job: UpdateJob = { state: "idle" };
const jobListeners = new Set<() => void>();
const setJob = (next: UpdateJob) => {
  job = next;
  for (const listener of jobListeners) listener();
};

export function useUpdateJob(): UpdateJob {
  return useSyncExternalStore(
    (listener) => {
      jobListeners.add(listener);
      return () => jobListeners.delete(listener);
    },
    () => job,
  );
}

/** Update what `plan` names, the server first. One at a time; the job says how it's going, and how it failed. */
export function startUpdate(plan: UpdatePlan) {
  if (job.state === "running" || (!plan.server && !plan.app)) return;
  setJob({ state: "running", step: plan.server ? "server" : "app", plan });
  installBoth(plan, flowDeps, (step) => setJob({ state: "running", step, plan })).then(
    () => setJob({ state: "idle" }),
    (e: unknown) => setJob({ state: "failed", error: e instanceof Error ? e.message : String(e), plan }),
  );
}

/** Forget a failed update (a new check or try starts clean). */
export const clearUpdateJob = () => {
  if (job.state === "failed") setJob({ state: "idle" });
};

// ── both ─────────────────────────────────────────────────────────────────────────

export type Updates = {
  readonly server: UpdateView | undefined;
  readonly app: AppUpdates | undefined;
  /** The server's version and channel, also when it doesn't update itself. */
  readonly serverVersion: string | undefined;
  readonly serverChannel: Channel | undefined;
  readonly connection: ConnectionStatus;
  /** The app and the server follow different channels. */
  readonly mismatch: { readonly app: Channel; readonly server: Channel } | undefined;
};

const noFake = () => () => {};
const noSnapshot = () => undefined;

export function useUpdates(): Updates {
  const realServer = useClient((s) => s.update);
  const info = useClient((s) => s.server);
  const realConnection = useClient((s) => s.connection);
  const realApp = useAppUpdates();
  const fakeServer = useSyncExternalStore(fakeUpdates?.subscribe ?? noFake, fakeUpdates?.server ?? noSnapshot);
  const fakeApp = useSyncExternalStore(fakeUpdates?.subscribe ?? noFake, fakeUpdates?.app ?? noSnapshot);
  const server = fakeServer ? fakeServer.update : realServer;
  const app = fakeServer ? fakeApp : realApp;
  const serverChannel = server?.channel ?? info?.channel;
  return {
    server,
    app,
    serverVersion: fakeServer ? fakeServer.version : info?.version,
    serverChannel,
    connection: fakeServer ? fakeServer.connection : realConnection,
    mismatch: app?.channel && serverChannel && app.channel !== serverChannel ? { app: app.channel, server: serverChannel } : undefined,
  };
}

/** Look for updates to both now. */
export const checkBoth = (updates: Updates) => {
  clearUpdateJob();
  return Promise.allSettled([
    updates.server ? sources.checkServer() : undefined,
    updates.app && updates.app.state !== "unavailable" ? sources.checkApp?.() : undefined,
  ]);
};

/** A line saying what the updater is doing, or `undefined` when it's idle. */
export function serverActivity(update: UpdateView | undefined): string | undefined {
  switch (update?.state) {
    case "checking":
      return "Checking for updates…";
    case "downloading":
      return `Downloading Top ${update.available?.version ?? ""}…`;
    case "restarting":
      return "Restarting on the new version…";
    case "failed":
      return update.error;
    default:
      return update?.error;
  }
}

export function appActivity(app: AppUpdates | undefined): string | undefined {
  switch (app?.state) {
    case "checking":
      return "Checking for updates…";
    case "downloading":
      return `Downloading Top ${app.available?.version ?? ""}${app.progress !== undefined ? ` (${app.progress}%)` : ""}…`;
    case "installing":
      return "Restarting on the new version…";
    case "failed":
      return app.error;
    default:
      return undefined;
  }
}

export const mismatchText = (mismatch: NonNullable<Updates["mismatch"]>) =>
  `This app gets ${channelName(mismatch.app)} updates, but your server gets ${channelName(mismatch.server)} ones, so some things may not work together.`;

/** "3 minutes ago", for when the last check was. */
export function useAgo(at: number | undefined): string | undefined {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  if (at === undefined) return undefined;
  const minutes = Math.round((now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} hour${hours === 1 ? "" : "s"} ago` : new Date(at).toLocaleDateString();
}
