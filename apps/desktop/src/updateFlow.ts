import type { ConnectionStatus, UpdateView } from "@top/client";
import type { AppUpdates } from "./bridge.ts";

export type ServerSide = {
  readonly version: string | undefined;
  readonly update: UpdateView | undefined;
  readonly connection: ConnectionStatus;
};

export type UpdateDeps = {
  readonly server: () => ServerSide;
  readonly subscribe: (listener: () => void) => () => void;
  readonly installServer: (version: string) => Promise<void>;
  readonly installApp: (() => Promise<AppUpdates | undefined>) | undefined;
  readonly restartTimeoutMs?: number;
  readonly startTimeoutMs?: number;
};

export type UpdatePlan = { readonly server?: string | undefined; readonly app?: string | undefined };

export type UpdateJob =
  | { readonly state: "idle" }
  | { readonly state: "running"; readonly step: "server" | "app"; readonly plan: UpdatePlan }
  | { readonly state: "failed"; readonly error: string; readonly plan: UpdatePlan };

export const RESTART_TIMEOUT_MS = 3 * 60_000;
export const START_TIMEOUT_MS = 30_000;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function waitForServer(version: string, deps: UpdateDeps): Promise<void> {
  const before = deps.server().update;
  return new Promise<void>((resolve, reject) => {
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
    const startTimer = setTimeout(
      () => fail("The server didn't start the update. It may be busy checking or updating: try again in a moment."),
      deps.startTimeoutMs ?? START_TIMEOUT_MS,
    );
    const look = () => {
      const { version: running, update, connection } = deps.server();
      if (connection === "open" && (running === version || update?.current === version)) return done(resolve);
      if (update !== before) started = true;
      if (!started) return;
      if (update?.state === "downloading" || update?.state === "restarting" || update?.state === "failed" || update?.rolledBack === version)
        clearTimeout(startTimer);
      if (update?.rolledBack === version) return fail(update.error ?? `Top ${version} didn't start, so the server went back.`);
      if (update?.state === "failed") return fail(update.error ?? "The server couldn't update.");
      if (update?.state === "restarting") restarted = true;
      if (connection !== "open" && !restarted) dropped = true;
      if (connection === "open" && update?.state === "idle") {
        if (update.available?.version !== version) return fail(`Top ${version} isn't the newest release any more. Check for updates again.`);
        if (dropped) return fail(`The server stopped before it finished updating to Top ${version}. Try again.`);
      }
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

export async function installBoth(plan: UpdatePlan, deps: UpdateDeps, onStep: (step: "server" | "app") => void = () => {}): Promise<void> {
  if (plan.server && deps.server().version !== plan.server) {
    onStep("server");
    if (deps.server().connection !== "open") throw new Error("Can't reach the server to update it. Try again once it's connected.");
    const back = waitForServer(plan.server, deps);
    back.catch(() => {});
    try {
      await deps.installServer(plan.server);
    } catch (e) {
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

export type UpdateStatus = {
  readonly kind: "unavailable" | "idle" | "checking" | "available" | "working" | "failed";
  readonly action: "check" | "install" | "none";
  readonly label: string;
  readonly versions: readonly string[];
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
  const plan: UpdatePlan = job.state === "running" ? job.plan : { server: serverOffer?.version, app: appOffer?.version };

  const from = (side: string, current: string | undefined, to: string) => (current === to ? `${side}: ${to}` : `${side}: ${current ?? "?"} → ${to}`);
  const versions = [plan.server && from("Server", server?.current ?? serverVersion, plan.server), plan.app && from("This app", app?.version, plan.app)].filter(
    (v): v is string => !!v,
  );

  const serverBusy = server?.state === "downloading" || server?.state === "restarting";
  const appBusy = app?.state === "downloading" || app?.state === "installing";
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
          : server?.rolledBack && server.error
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
