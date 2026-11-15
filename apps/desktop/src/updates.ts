/**
 * Updates as the UI sees them: the server's (from the daemon, through the client) and this app's own
 * (from electron/updates.js). Each follows a channel of its own: one server has many devices.
 *
 * Nothing installs until the user presses Update. "Later" hides a version until a newer one comes out.
 */
import { type Channel, channelName, type UpdateView } from "@top/client";
import { useEffect, useState, useSyncExternalStore } from "react";
import { type AppUpdates, appUpdates } from "./bridge.ts";
import { top, useClient } from "./top.ts";

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

// ── "Later" ──────────────────────────────────────────────────────────────────────

type Dismissed = { readonly server?: string; readonly app?: string; readonly mismatch?: string };
const DISMISSED = "top.updates.dismissed";
const readDismissed = (): Dismissed => {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(DISMISSED) ?? "{}");
    return typeof value === "object" && value !== null ? (value as Dismissed) : {};
  } catch {
    return {};
  }
};
let dismissed = readDismissed();
const dismissListeners = new Set<() => void>();

export function dismiss(change: Dismissed) {
  dismissed = { ...dismissed, ...change };
  try {
    localStorage.setItem(DISMISSED, JSON.stringify(dismissed));
  } catch {
    // Remembered for this session only.
  }
  for (const listener of dismissListeners) listener();
}

export function useDismissed(): Dismissed {
  return useSyncExternalStore(
    (listener) => {
      dismissListeners.add(listener);
      return () => dismissListeners.delete(listener);
    },
    () => dismissed,
  );
}

// ── both ─────────────────────────────────────────────────────────────────────────

export type Updates = {
  readonly server: UpdateView | undefined;
  readonly app: AppUpdates | undefined;
  /** The server's version and channel, also when it doesn't update itself. */
  readonly serverVersion: string | undefined;
  readonly serverChannel: Channel | undefined;
  /** The app and the server follow different channels. */
  readonly mismatch: { readonly app: Channel; readonly server: Channel } | undefined;
};

export function useUpdates(): Updates {
  const server = useClient((s) => s.update);
  const info = useClient((s) => s.server);
  const app = useAppUpdates();
  const serverChannel = server?.channel ?? info?.channel;
  return {
    server,
    app,
    serverVersion: info?.version,
    serverChannel,
    mismatch: app?.channel && serverChannel && app.channel !== serverChannel ? { app: app.channel, server: serverChannel } : undefined,
  };
}

/** Look for updates to both now. */
export const checkBoth = (updates: Updates) =>
  Promise.allSettled([updates.server ? top.checkForUpdate() : undefined, updates.app?.state !== "unavailable" ? appUpdates?.check() : undefined]);

/**
 * Install what's available: the server first (it restarts on the new version), then the app (it quits
 * and starts the new one, which reconnects to the updated server). Rejects with the server's refusal.
 */
export async function installBoth(updates: Updates) {
  const server = updates.server?.available;
  if (server) {
    await top.installUpdate(server.version);
    if (updates.app?.available) await serverRunning(server.version);
  }
  if (updates.app?.available) await appUpdates?.install();
}

/** Resolves when the server is back on `version`; rejects if its update fails or is rolled back. */
function serverRunning(version: string) {
  return new Promise<void>((resolve, reject) => {
    // The state before the install may be an old failure; only one after it has started counts.
    let started = false;
    const look = () => {
      const { server, update } = top.getSnapshot();
      if (server?.version === version) return done(resolve);
      if (update && update.state !== "idle" && update.state !== "failed") started = true;
      else if (!started) return;
      // The server clears an earlier try's rollback when this one starts.
      else if (update?.rolledBack === version) done(() => reject(new Error(update.error ?? `Top ${version} didn't start.`)));
      else if (update?.state === "failed") done(() => reject(new Error(update.error ?? "The server couldn't update.")));
    };
    const done = (settle: () => void) => {
      unsubscribe();
      settle();
    };
    const unsubscribe = top.subscribe(look);
    look();
  });
}

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
