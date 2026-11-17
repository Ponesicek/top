import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, ipcMain } from "electron";

const BUILT_FOR = typeof __TOP_CHANNEL__ === "string" && (__TOP_CHANNEL__ === "stable" || __TOP_CHANNEL__ === "nightly") ? __TOP_CHANNEL__ : undefined;
const CHECK_EVERY_MS = 6 * 60 * 60_000;
const FIRST_CHECK_MS = 15_000;

/**
 * @typedef {"stable" | "nightly"} Channel
 * @typedef {{
 *   version: string;
 *   channel?: Channel;
 *   state: "unavailable" | "idle" | "checking" | "downloading" | "installing" | "failed";
 *   available?: { version: string; notes: string[] };
 *   progress?: number;
 *   checkedAt?: number;
 *   error?: string;
 * }} AppUpdates
 */

/**
 * @param {unknown} notes
 * @returns {string[]}
 */
function notesOf(notes) {
  const html = Array.isArray(notes) ? notes.map((n) => (typeof n?.note === "string" ? n.note : "")).join("\n") : typeof notes === "string" ? notes : "";
  return [...html.matchAll(/<li>([\s\S]*?)<\/li>/g)]
    .map((m) =>
      (m[1] ?? "")
        .replace(/<[^>]+>/g, "")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, "&")
        .trim(),
    )
    .filter(Boolean)
    .slice(0, 20);
}

/** @param {unknown} error */
const firstLine = (error) => (error instanceof Error ? error.message : String(error)).split("\n")[0];

/** @param {() => Electron.WebContents[]} pages */
export function startUpdates(pages) {
  const settingsPath = join(app.getPath("userData"), "updates.json");
  /** @returns {Channel | undefined} */
  const savedChannel = () => {
    try {
      const channel = JSON.parse(readFileSync(settingsPath, "utf8"))?.channel;
      return channel === "stable" || channel === "nightly" ? channel : undefined;
    } catch {
      return undefined;
    }
  };

  const updatable = app.isPackaged && BUILT_FOR !== undefined && process.platform === "linux" && !!process.env.APPIMAGE;
  /** @type {AppUpdates} */
  let state = {
    version: app.getVersion(),
    ...(BUILT_FOR ? { channel: savedChannel() ?? BUILT_FOR } : {}),
    state: updatable ? "idle" : "unavailable",
  };
  /** @param {{ [K in keyof AppUpdates]?: AppUpdates[K] | undefined }} change */
  const set = (change) => {
    /** @type {Record<string, unknown>} */
    const next = { ...state, ...change };
    for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
    state = /** @type {AppUpdates} */ (next);
    for (const page of pages()) if (!page.isDestroyed()) page.send("top:updates:changed", state);
  };

  const updater = updatable
    ? import("electron-updater").then(({ default: { autoUpdater } }) => {
        autoUpdater.autoDownload = false;
        autoUpdater.autoInstallOnAppQuit = false;
        autoUpdater.logger = null;
        autoUpdater.on("error", () => {});
        autoUpdater.on("download-progress", (info) => set({ state: "downloading", progress: Math.round(info.percent) }));
        return autoUpdater;
      })
    : undefined;

  /** @param {Channel} channel */
  const follow = async (channel) => {
    const autoUpdater = await updater;
    if (!autoUpdater) return;
    autoUpdater.allowPrerelease = channel === "nightly";
    autoUpdater.channel = channel === "nightly" ? "nightly" : "latest";
    autoUpdater.allowDowngrade = false;
  };

  let checking = false;
  const check = async () => {
    const autoUpdater = await updater;
    if (!autoUpdater || checking || state.state === "downloading" || state.state === "installing") return state;
    checking = true;
    set({ state: "checking", error: undefined });
    try {
      const result = await autoUpdater.checkForUpdates();
      const info = result?.isUpdateAvailable ? result.updateInfo : undefined;
      set({ state: "idle", checkedAt: Date.now(), available: info ? { version: info.version, notes: notesOf(info.releaseNotes) } : undefined });
    } catch (error) {
      set({ state: "failed", error: `Couldn't check for app updates: ${firstLine(error)}` });
    } finally {
      checking = false;
    }
    return state;
  };

  const install = async () => {
    const autoUpdater = await updater;
    if (!autoUpdater || !state.available || state.state === "downloading" || state.state === "installing") return state;
    set({ state: "downloading", progress: 0, error: undefined });
    try {
      await autoUpdater.downloadUpdate();
      set({ state: "installing" });
      setImmediate(() => autoUpdater.quitAndInstall(true, true));
    } catch (error) {
      set({ state: "failed", error: `Couldn't download the app update: ${firstLine(error)}` });
    }
    return state;
  };

  /** @param {unknown} channel */
  const setChannel = async (channel) => {
    if (!updatable || (channel !== "stable" && channel !== "nightly")) return state;
    try {
      writeFileSync(settingsPath, JSON.stringify({ channel }));
    } catch {}
    await follow(channel);
    set({ channel, available: undefined });
    return check();
  };

  ipcMain.handle("top:updates:state", () => state);
  ipcMain.handle("top:updates:check", check);
  ipcMain.handle("top:updates:install", install);
  ipcMain.handle("top:updates:channel", (_event, /** @type {unknown} */ channel) => setChannel(channel));

  if (!updatable) return;
  void follow(state.channel ?? "stable");
  setTimeout(check, FIRST_CHECK_MS);
  setInterval(check, CHECK_EVERY_MS);
}
