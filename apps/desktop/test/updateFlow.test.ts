import type { ConnectionStatus, UpdateView } from "@top/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppUpdates } from "../src/bridge.ts";
import { describeUpdates, installBoth, type ServerSide, type StatusInput, type UpdateDeps, type UpdateJob } from "../src/updateFlow.ts";

const OLD = "0.1.0-nightly.20261115.2";
const NEW = "0.1.0-nightly.20261115.3";

const offer = { version: NEW, notes: ["Faster"], url: "https://example.com" };
const idleView: UpdateView = { channel: "nightly", current: OLD, state: "idle", available: offer };

function harness(options: { update?: UpdateView; connection?: ConnectionStatus; app?: AppUpdates["state"]; appError?: string } = {}) {
  let side: ServerSide = { version: OLD, update: options.update ?? idleView, connection: options.connection ?? "open" };
  const listeners = new Set<() => void>();
  const log: string[] = [];
  const set = (change: { version?: string; update?: Partial<UpdateView>; connection?: ConnectionStatus }) => {
    side = {
      version: change.version ?? side.version,
      update: change.update ? ({ ...side.update, ...change.update } as UpdateView) : side.update,
      connection: change.connection ?? side.connection,
    };
    for (const listener of listeners) listener();
  };
  const deps: UpdateDeps = {
    server: () => side,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    installServer: vi.fn(async (version: string) => {
      log.push(`server ${version}`);
    }),
    installApp: vi.fn(async () => {
      log.push("app");
      const state = options.app ?? "installing";
      return { version: OLD, state, ...(options.appError ? { error: options.appError } : {}) } satisfies AppUpdates;
    }),
    restartTimeoutMs: 1000,
    startTimeoutMs: 500,
  };
  return { deps, set, log, listeners };
}

const flush = () => new Promise((done) => setTimeout(done, 0));

afterEach(() => {
  vi.useRealTimers();
});

describe("installBoth", () => {
  it("updates the server, waits for it to come back on the new version, then updates the app", async () => {
    const { deps, set, log, listeners } = harness();
    const steps: string[] = [];
    const done = installBoth({ server: NEW, app: NEW }, deps, (step) => steps.push(step));
    await flush();
    expect(log).toEqual([`server ${NEW}`]);

    set({ update: { state: "downloading" } });
    set({ update: { state: "restarting" } });
    set({ connection: "reconnecting" });
    await flush();
    expect(log).toEqual([`server ${NEW}`]);

    set({ connection: "open" });
    set({ connection: "reconnecting" });
    set({ connection: "open", version: NEW, update: { current: NEW, state: "idle" } });
    await done;
    expect(log).toEqual([`server ${NEW}`, "app"]);
    expect(steps).toEqual(["server", "app"]);
    expect(listeners.size).toBe(0);
  });

  it("doesn't touch the app when the server's download fails", async () => {
    const { deps, set, log } = harness();
    const done = installBoth({ server: NEW, app: NEW }, deps);
    await flush();
    set({ update: { state: "downloading" } });
    set({ update: { state: "failed", error: "Couldn't download the update: 404" } });
    await expect(done).rejects.toThrow("Couldn't download the update: 404");
    expect(log).toEqual([`server ${NEW}`]);
  });

  it("ignores a failure left over from an earlier try", async () => {
    const { deps, set, log } = harness({ update: { ...idleView, state: "failed", error: "old failure" } });
    const done = installBoth({ server: NEW, app: NEW }, deps);
    await flush();
    set({ update: { state: "downloading" } });
    set({ connection: "reconnecting" });
    set({ connection: "open", version: NEW, update: { current: NEW, state: "idle" } });
    await done;
    expect(log).toEqual([`server ${NEW}`, "app"]);
  });

  it("says so when the new server didn't start and was rolled back", async () => {
    const { deps, set, log } = harness();
    const done = installBoth({ server: NEW, app: NEW }, deps);
    await flush();
    set({ update: { state: "restarting" } });
    set({ connection: "reconnecting" });
    set({ connection: "open", update: { state: "idle", rolledBack: NEW, error: `Top ${NEW} didn't start.` } });
    await expect(done).rejects.toThrow(`Top ${NEW} didn't start.`);
    expect(log).toEqual([`server ${NEW}`]);
  });

  it("passes on a request that fails (offline, or turned down)", async () => {
    const { deps: base, log } = harness();
    const deps: UpdateDeps = {
      ...base,
      installServer: async () => {
        throw new Error("The server is already checking for or installing an update.");
      },
    };
    await expect(installBoth({ server: NEW, app: NEW }, deps)).rejects.toThrow("already checking");
    expect(log).toEqual([]);
  });

  it("stops waiting when the server never starts (a busy daemon only logs its refusal)", async () => {
    vi.useFakeTimers();
    const { deps, log } = harness();
    const done = installBoth({ server: NEW, app: NEW }, deps);
    const failed = expect(done).rejects.toThrow("didn't start the update");
    await vi.advanceTimersByTimeAsync(501);
    await failed;
    expect(log).toEqual([`server ${NEW}`]);
  });

  it("keeps waiting for a start through a check, and gives up when the check was all that happened", async () => {
    vi.useFakeTimers();
    const { deps, set, log } = harness();
    const done = installBoth({ server: NEW, app: NEW }, deps);
    const failed = expect(done).rejects.toThrow("didn't start the update");
    await vi.advanceTimersByTimeAsync(0);
    set({ update: { state: "checking" } });
    set({ update: { state: "idle" } });
    await vi.advanceTimersByTimeAsync(501);
    await failed;
    expect(log).toEqual([`server ${NEW}`]);
  });

  it("rides out a dropped connection while the server downloads", async () => {
    vi.useFakeTimers();
    const { deps, set, log } = harness();
    const done = installBoth({ server: NEW, app: NEW }, deps);
    await vi.advanceTimersByTimeAsync(0);
    set({ update: { state: "downloading" } });
    set({ connection: "reconnecting" });
    await vi.advanceTimersByTimeAsync(5000);
    set({ connection: "open", update: { state: "downloading" } });
    set({ update: { state: "restarting" } });
    set({ connection: "reconnecting" });
    set({ connection: "open", version: NEW, update: { current: NEW, state: "idle" } });
    await done;
    expect(log).toEqual([`server ${NEW}`, "app"]);
  });

  it("says so when the server stopped partway (it came back idle, not updating)", async () => {
    const { deps, set, log } = harness();
    const done = installBoth({ server: NEW, app: NEW }, deps);
    await flush();
    set({ update: { state: "downloading" } });
    set({ connection: "reconnecting" });
    set({ connection: "open", update: { state: "idle" } });
    await expect(done).rejects.toThrow("stopped before it finished");
    expect(log).toEqual([`server ${NEW}`]);
  });

  it("goes straight to the app when the server is already on the new version (a retry after the app failed)", async () => {
    const { deps, set, log } = harness({ update: { channel: "nightly", current: NEW, state: "idle" } });
    set({ version: NEW });
    await installBoth({ server: NEW, app: NEW }, deps);
    expect(log).toEqual(["app"]);
  });

  it("stops waiting when the server gives up because something newer is out", async () => {
    const { deps, set, log } = harness();
    const done = installBoth({ server: NEW, app: NEW }, deps);
    await flush();
    set({ update: { state: "checking" } });
    set({ update: { state: "idle", available: { ...offer, version: "0.1.0-nightly.20261115.4" } } });
    await expect(done).rejects.toThrow("isn't the newest release any more");
    expect(log).toEqual([`server ${NEW}`]);
  });

  it("gives up honestly when the server doesn't come back", async () => {
    vi.useFakeTimers();
    const { deps, set, log } = harness();
    const done = installBoth({ server: NEW, app: NEW }, deps);
    const failed = expect(done).rejects.toThrow("hasn't come back");
    await vi.advanceTimersByTimeAsync(0);
    set({ update: { state: "downloading" } });
    await vi.advanceTimersByTimeAsync(10_000);
    set({ update: { state: "restarting" } });
    set({ connection: "reconnecting" });
    await vi.advanceTimersByTimeAsync(1001);
    await failed;
    expect(log).toEqual([`server ${NEW}`]);
  });

  it("won't start the server's update while it can't reach it", async () => {
    const { deps, log } = harness({ connection: "reconnecting" });
    await expect(installBoth({ server: NEW, app: NEW }, deps)).rejects.toThrow("Can't reach the server");
    expect(log).toEqual([]);
  });

  it("updates only the app when only the app has an update", async () => {
    const { deps, log } = harness({ connection: "reconnecting" });
    await installBoth({ app: NEW }, deps);
    expect(log).toEqual(["app"]);
  });

  it("reports the app's own failure", async () => {
    const { deps } = harness({ app: "failed", appError: "Couldn't download the app update: offline" });
    await expect(installBoth({ app: NEW }, deps)).rejects.toThrow("offline");
  });
});

describe("describeUpdates", () => {
  const idle: UpdateJob = { state: "idle" };
  const app = (state: AppUpdates["state"], extra: Partial<AppUpdates> = {}): AppUpdates => ({ version: OLD, channel: "nightly", state, ...extra });
  const input = (over: Partial<StatusInput>): StatusInput => ({
    server: undefined,
    app: undefined,
    serverVersion: OLD,
    connection: "open",
    job: idle,
    ...over,
  });

  it("has nothing to do when neither updates itself (a checkout, in a browser)", () => {
    expect(describeUpdates(input({})).kind).toBe("unavailable");
    expect(describeUpdates(input({ app: app("unavailable") })).action).toBe("none");
  });

  it("checks for updates when up to date", () => {
    const status = describeUpdates(input({ server: { channel: "nightly", current: OLD, state: "idle" }, app: app("idle") }));
    expect(status).toMatchObject({ kind: "idle", action: "check", label: "Check for updates" });
    expect(describeUpdates(input({ app: app("checking") })).kind).toBe("checking");
  });

  it("offers both updates in one press", () => {
    const status = describeUpdates(input({ server: idleView, app: app("idle", { available: { version: NEW, notes: [] } }) }));
    expect(status).toMatchObject({ kind: "available", action: "install", plan: { server: NEW, app: NEW } });
    expect(status.versions).toEqual([`Server: ${OLD} → ${NEW}`, `This app: ${OLD} → ${NEW}`]);
  });

  it("follows the update through the server's restart and the reconnect", () => {
    const job: UpdateJob = { state: "running", step: "server", plan: { server: NEW, app: NEW } };
    const downloading = describeUpdates(input({ job, server: { ...idleView, state: "downloading" }, app: app("idle") }));
    expect(downloading).toMatchObject({ kind: "working", action: "none" });
    expect(downloading.progress).toEqual([`Server: downloading Top ${NEW}…`, "This app: updates after the server"]);

    const gone = describeUpdates(input({ job, server: { ...idleView, state: "restarting" }, connection: "reconnecting", app: app("idle") }));
    expect(gone.progress[0]).toBe("Server: restarting, waiting for it to come back…");

    const appJob: UpdateJob = { state: "running", step: "app", plan: { server: NEW, app: NEW } };
    const back = describeUpdates(input({ job: appJob, serverVersion: NEW, server: { ...idleView, current: NEW }, app: app("downloading", { progress: 40 }) }));
    expect(back.progress).toEqual([`Server: on Top ${NEW}`, `This app: downloading Top ${NEW} (40%)…`]);
    expect(back.versions).toEqual([`Server: ${NEW}`, `This app: ${OLD} → ${NEW}`]);
  });

  it("shows what failed, and offers to try again", () => {
    const job: UpdateJob = { state: "failed", error: "Couldn't download the update: 404", plan: { server: NEW } };
    expect(describeUpdates(input({ job, server: idleView }))).toMatchObject({ kind: "failed", action: "install", error: "Couldn't download the update: 404" });
    const checkFailed = describeUpdates(input({ server: { channel: "nightly", current: OLD, state: "failed", error: "GitHub is down" } }));
    expect(checkFailed).toMatchObject({ kind: "failed", action: "check", error: "GitHub is down" });
  });

  it("retries what's on offer now, not what was on offer when it failed", () => {
    const newer = "0.1.0-nightly.20261115.4";
    const job: UpdateJob = { state: "failed", error: `Top ${NEW} isn't the newest release any more.`, plan: { server: NEW } };
    const status = describeUpdates(input({ job, server: { ...idleView, available: { ...offer, version: newer } } }));
    expect(status).toMatchObject({ kind: "failed", action: "install", plan: { server: newer } });
  });

  it("shows a failure, not a spinner, when the server never came back (its last word was 'restarting')", () => {
    const job: UpdateJob = { state: "failed", error: "The server hasn't come back", plan: { server: NEW } };
    const status = describeUpdates(input({ job, server: { ...idleView, state: "restarting" }, connection: "reconnecting" }));
    expect(status).toMatchObject({ kind: "failed", error: "The server hasn't come back" });
  });

  it("tells about a rollback it didn't see happen (after a relaunch, or from another device), until the next check", () => {
    const status = describeUpdates(input({ server: { ...idleView, rolledBack: NEW, error: `Top ${NEW} didn't start.` } }));
    expect(status).toMatchObject({ kind: "failed", error: `Top ${NEW} didn't start.` });
    expect(describeUpdates(input({ server: { ...idleView, rolledBack: NEW } })).kind).toBe("available");
  });

  it("doesn't offer to try again while the server is visibly updating", () => {
    const job: UpdateJob = { state: "failed", error: "The server didn't start the update.", plan: { server: NEW } };
    expect(describeUpdates(input({ job, server: { ...idleView, state: "downloading" } }))).toMatchObject({ kind: "working", action: "none" });
  });

  it("counts an update started elsewhere (another device, or Settings) as working", () => {
    expect(describeUpdates(input({ server: { ...idleView, state: "downloading" } })).kind).toBe("working");
  });
});
