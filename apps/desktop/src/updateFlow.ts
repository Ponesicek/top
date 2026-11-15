/**
 * Updating the server and this app together, and what the sidebar's update button says about it.
 * Kept free of the app's client and window so it can be tested on its own: `updates.ts` wires it to
 * the real ones (or, in development, to `devUpdates.ts`).
 *
 * The server goes first: it downloads, restarts on the new version (the connection drops and comes
 * back), and only once it's back on that version does the app download and restart on its own.
 */
import type { ConnectionStatus, UpdateView } from "@top/client";
import type { AppUpdates } from "./bridge.ts";

/** The server as the update flow sees it: what it runs, its updater, and whether we can reach it. */
export type ServerSide = {
  readonly version: string | undefined;
  readonly update: UpdateView | undefined;
  readonly connection: ConnectionStatus;
};

export type UpdateDeps = {
  readonly server: () => ServerSide;
  /** Called on every change to `server()`; returns the unsubscribe. */
  readonly subscribe: (listener: () => void) => () => void;
  readonly installServer: (version: string) => Promise<void>;
  /** Downloads the app's update, then quits and starts it; resolves with the state after (`failed` says why). */
  readonly installApp: (() => Promise<AppUpdates | undefined>) | undefined;
  /** How long the server may take to come back once it has started restarting. */
  readonly restartTimeoutMs?: number;
  /** How long the server may take to show it has started (it says no to a second update only in its log). */
  readonly startTimeoutMs?: number;
};

/** What to update: the versions on offer when the user pressed Update. */
export type UpdatePlan = { readonly server?: string | undefined; readonly app?: string | undefined };

/** The update the user started, as far as it has got. */
export type UpdateJob =
  | { readonly state: "idle" }
  | { readonly state: "running"; readonly step: "server" | "app"; readonly plan: UpdatePlan }
  | { readonly state: "failed"; readonly error: string; readonly plan: UpdatePlan };

export const RESTART_TIMEOUT_MS = 3 * 60_000;
export const START_TIMEOUT_MS = 30_000;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Resolves when the server is back on `version`; rejects when its update fails, is rolled back, stops, or
 * the server doesn't come back within `restartTimeoutMs` of starting to restart. A download can take as
 * long as it takes: the server says how it's going, and a dropped connection while it downloads isn't a
 * failure by itself.
 */
export function waitForServer(version: string, deps: UpdateDeps): Promise<void> {
  const before = deps.server().update;
  return new Promise<void>((resolve, reject) => {
    // The view from before the install may hold an old failure: only a newer one counts.
    let started = false;
    let restarted = false;
    let dropped = false;
    let restartTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const done = (settle: () => void) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      clearTimeout(startTimer);
      clearTimeout(restartTimer);
      settle();
    };
    const fail = (text: string) => done(() => reject(new Error(text)));
    // The daemon answers the request before it starts, and a busy one only logs its refusal.
    const startTimer = setTimeout(
      () => fail("The server didn't start the update. It may be busy checking or updating: try again in a moment."),
      deps.startTimeoutMs ?? START_TIMEOUT_MS,
    );
    const look = () => {
      const { version: running, update, connection } = deps.server();
      if (connection === "open" && (running === version || update?.current === version)) return done(resolve);
      if (update !== before) started = true;
      if (!started) return;
      // Only real work shows it took this install: a check (the daemon's own, or install's) may come and go first.
      if (update?.state === "downloading" || update?.state === "restarting" || update?.state === "failed" || update?.rolledBack === version)
        clearTimeout(startTimer);
      // The server clears an earlier try's rollback when this one starts.
      if (update?.rolledBack === version) return fail(update.error ?? `Top ${version} didn't start, so the server went back.`);
      if (update?.state === "failed") return fail(update.error ?? "The server couldn't update.");
      if (update?.state === "restarting") restarted = true;
      if (connection !== "open" && !restarted) dropped = true;
      if (connection === "open" && update?.state === "idle") {
        // It looked again and found something else newest: it gives up without a failure.
        if (update.available?.version !== version) return fail(`Top ${version} isn't the newest release any more. Check for updates again.`);
        // Back from a drop, and not updating: it stopped (or restarted) before it finished.
        if (dropped) return fail(`The server stopped before it finished updating to Top ${version}. Try again.`);
      }
      // Restarting: from here it has a while to come back.
      if (restarted && !restartTimer)
        restartTimer = setTimeout(
          () => fail(`The server hasn't come back on Top ${version} yet. It may still be starting: check again in a moment.`),
          deps.restartTimeoutMs ?? RESTART_TIMEOUT_MS,
        );
    };
    const unsubscribe = deps.subscribe(look);
    look();
  });
}

/**
 * Install `plan`: the server first, then the app. `onStep` hears each step as it starts. Rejects with
 * what went wrong; the app isn't touched when the server's update fails.
 */
export async function installBoth(plan: UpdatePlan, deps: UpdateDeps, onStep: (step: "server" | "app") => void = () => {}): Promise<void> {
  // Already there (the app's step failed last time): nothing to do on the server.
  if (plan.server && deps.server().version !== plan.server) {
    onStep("server");
    if (deps.server().connection !== "open") throw new Error("Can't reach the server to update it. Try again once it's connected.");
    const back = waitForServer(plan.server, deps);
    // It may give up before the request below settles; it's awaited after.
    back.catch(() => {});
    try {
      await deps.installServer(plan.server);
    } catch (e) {
      // The request itself failed (offline, or turned down): nothing is happening.
      throw new Error(message(e));
    }
    await back;
  }
  if (plan.app && deps.installApp) {
    onStep("app");
    const after = await deps.installApp();
    if (after?.state === "failed") throw new Error(after.error ?? "The app couldn't update.");
  }
}

// ── what the button says ────────────────────────────────────────────────────────────

export type UpdateStatus = {
  /**
   * `unavailable`: neither updates itself from here (a checkout). `idle`: up to date, or not checked.
   * `checking`, `available`, `working` (updating), `failed`.
   */
  readonly kind: "unavailable" | "idle" | "checking" | "available" | "working" | "failed";
  /** What pressing the button does. */
  readonly action: "check" | "install" | "none";
  /** The button's name, for its label and screen readers. */
  readonly label: string;
  /** What's on offer: "Server: 0.1.0 → 0.1.1". */
  readonly versions: readonly string[];
  /** What's happening right now, one line per side. */
  readonly progress: readonly string[];
  readonly error: string | undefined;
  readonly plan: UpdatePlan;
};

export type StatusInput = {
  readonly server: UpdateView | undefined;
  readonly app: AppUpdates | undefined;
  readonly serverVersion: string | undefined;
  readonly connection: ConnectionStatus;
  readonly job: UpdateJob;
};

const appUpdatable = (app: AppUpdates | undefined): app is AppUpdates => !!app && app.state !== "unavailable";

export function describeUpdates({ server, app, serverVersion, connection, job }: StatusInput): UpdateStatus {
  const serverOffer = server?.available;
  const appOffer = appUpdatable(app) ? app.available : undefined;
  // A running update keeps what it set out to do; otherwise it's what's on offer now (a retry takes the newest).
  const plan: UpdatePlan = job.state === "running" ? job.plan : { server: serverOffer?.version, app: appOffer?.version };

  // Once a side is on the new version, there's no arrow left to show.
  const from = (side: string, current: string | undefined, to: string) => (current === to ? `${side}: ${to}` : `${side}: ${current ?? "?"} → ${to}`);
  const versions = [plan.server && from("Server", server?.current ?? serverVersion, plan.server), plan.app && from("This app", app?.version, plan.app)].filter(
    (v): v is string => !!v,
  );

  const serverBusy = server?.state === "downloading" || server?.state === "restarting";
  const appBusy = app?.state === "downloading" || app?.state === "installing";
  // A failure of ours outranks the last word from a server that never came back ("restarting"), but not a
  // server that is visibly at work (another device's update, or one that carried on after we gave up).
  const running = job.state === "running" || appBusy || (serverBusy && (connection === "open" || job.state === "idle"));

  const progress: string[] = [];
  if (running) {
    const serverDone = plan.server !== undefined && serverVersion === plan.server && connection === "open" && !serverBusy;
    if (plan.server) {
      if (serverDone) progress.push(`Server: on Top ${plan.server}`);
      else if (connection !== "open")
        progress.push(server?.state === "restarting" ? "Server: restarting, waiting for it to come back…" : "Server: can't reach it, reconnecting…");
      else if (server?.state === "restarting") progress.push(`Server: restarting on Top ${plan.server}…`);
      else if (server?.state === "downloading") progress.push(`Server: downloading Top ${plan.server}…`);
      else progress.push("Server: starting the update…");
    }
    if (plan.app) {
      if (app?.state === "downloading") progress.push(`This app: downloading Top ${plan.app}${app.progress !== undefined ? ` (${app.progress}%)` : ""}…`);
      else if (app?.state === "installing") progress.push(`This app: restarting on Top ${plan.app}…`);
      else if (plan.server && !serverDone) progress.push("This app: updates after the server");
      else progress.push("This app: starting the update…");
    }
  }

  const error =
    job.state === "failed"
      ? job.error
      : running
        ? undefined
        : server?.state === "failed"
          ? (server.error ?? "The server couldn't check for updates.")
          : // It came back on the old version after the new one didn't start (seen here after a relaunch, or from another device).
            // (Until the next check, which clears the error: the daemon keeps `rolledBack` until the next install.)
            server?.rolledBack && server.error
            ? server.error
            : app?.state === "failed"
              ? (app.error ?? "This app couldn't check for updates.")
              : undefined;

  const base = { versions, progress, error, plan };
  if (running) return { ...base, kind: "working", action: "none", label: "Updating…" };
  if (!server && !appUpdatable(app)) return { ...base, kind: "unavailable", action: "none", label: "Updates" };
  if (server?.state === "checking" || app?.state === "checking") return { ...base, kind: "checking", action: "none", label: "Checking for updates…" };
  const offer = !!(serverOffer || appOffer);
  if (error) return { ...base, kind: "failed", action: offer ? "install" : "check", label: offer ? "Try the update again" : "Check for updates again" };
  if (offer) return { ...base, kind: "available", action: "install", label: serverOffer && appOffer ? "Update the server and this app" : "Update Top" };
  return { ...base, kind: "idle", action: "check", label: "Check for updates" };
}
