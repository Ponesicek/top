// Electron main process. Deliberately thin: the renderer owns the socket and all state, so the
// same UI runs in a browser (pnpm web) and the main process never sits on the hot path.

import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain, nativeTheme, shell } from "electron";
import { startUpdates } from "./updates.js";

const here = dirname(fileURLToPath(import.meta.url));
// The profile (cache, settings) lives in Top's home beside the daemon's, not in Electron's default folder.
const topHome = process.env.TOP_HOME ? resolve(process.env.TOP_HOME.replace(/^~(?=$|\/)/, homedir())) : join(homedir(), ".top");
app.setPath("userData", process.env.TOP_USER_DATA ?? join(topHome, "desktop"));
if (process.env.TOP_THEME === "dark" || process.env.TOP_THEME === "light") nativeTheme.themeSource = process.env.TOP_THEME;
const devUrl = process.env.VITE_DEV_SERVER_URL;
const query = process.env.TOP_QUERY ?? "";
/** `pnpm screenshot` captures the page without putting a window where anyone sees it. */
const headless = process.env.TOP_BENCH === "screenshot";

/**
 * No title bar: the app's own headers are the window's drag areas. The sidebar isn't one: it takes clicks
 * like any other content. macOS keeps its traffic lights inset; Windows and Linux keep their window
 * buttons, drawn over the header's top-right corner in the app's own background (`--background` in
 * styles.css) and text colors.
 */
const overlay = () =>
  nativeTheme.shouldUseDarkColors ? { color: "#141413", symbolColor: "#eeedea", height: 40 } : { color: "#fefdfc", symbolColor: "#1a1917", height: 40 };

function createWindow() {
  const mac = process.platform === "darwin";
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 420,
    minHeight: 420,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#141413" : "#fefdfc",
    // Linux and Windows show this in the taskbar when no launcher supplies an icon; macOS takes its own from the app bundle.
    icon: join(here, "../assets/icons/512x512.png"),
    titleBarStyle: mac ? "hiddenInset" : "hidden",
    ...(mac ? {} : { titleBarOverlay: overlay() }),
    webPreferences: {
      // Lets the page set its own zoom (the "Interface size" setting); see preload.cjs.
      preload: join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      // Chromium's PDF viewer, for PDFs in the Files panel.
      plugins: true,
      // Screenshots render in a window nobody sees, so it must keep painting as if in front.
      ...(headless ? { backgroundThrottling: false } : {}),
    },
  });
  // No File/Edit/View/Window bar on Linux and Windows: typing, copy and paste work without it. macOS
  // keeps its menu, which lives in the screen's top bar and carries Cmd+C/V/Q.
  if (process.platform !== "darwin") {
    win.removeMenu();
    // The menu was also how dev builds opened DevTools and reloaded.
    if (devUrl) {
      win.webContents.on("before-input-event", (event, input) => {
        if (input.type !== "keyDown") return;
        const key = input.key.toLowerCase();
        if (input.key === "F12" || (input.control && input.shift && key === "i")) {
          event.preventDefault();
          win.webContents.toggleDevTools();
        } else if (input.control && !input.shift && key === "r") {
          event.preventDefault();
          win.webContents.reload();
        }
      });
    }
  }
  if (!mac) {
    // The app follows the system's light/dark setting; so do the window buttons.
    const recolor = () => !win.isDestroyed() && win.setTitleBarOverlay(overlay());
    nativeTheme.on("updated", recolor);
    win.on("closed", () => nativeTheme.off("updated", recolor));
  }
  if (!headless) win.once("ready-to-show", () => win.show());
  // Electron draws no new frames for a window that has never been shown, so a capture of one shows the
  // page as it first loaded, not as the screenshot left it. `pnpm screenshot` shows its window instead:
  // without focus, see-through and off-screen (where there's no display, inside xvfb anyway).
  else
    win.once("ready-to-show", () => {
      win.setOpacity(0);
      win.setPosition(-20_000, -20_000);
      win.showInactive();
    });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (url !== win.webContents.getURL()) event.preventDefault();
  });
  if (devUrl) void win.loadURL(devUrl + query);
  else void win.loadFile(join(here, "../dist/index.html"), { search: query.replace(/^\?/, "") });
  return win;
}

// ── Top on the tailnet ──────────────────────────────────────────────────────────
// The page can't run programs, so finding daemons on the user's tailnet happens here: ask the local
// Tailscale which devices are online, then ask each for `/.well-known/top` on Top's tailnet port
// (TAILNET_PORT in apps/server/src/tailscale.ts). A daemon answers only devices it lets in; one that
// refuses this device still says it's there.

const TAILNET_PORT = 7357;
/** @type {Partial<Record<NodeJS.Platform, string[]>>} */
const TAILSCALE = {
  darwin: ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"],
  win32: ["tailscale", "C:\\Program Files\\Tailscale\\tailscale.exe"],
};

/**
 * What this reads of `tailscale status --json` (unchecked: the page checks the answer it builds, see src/bridge.ts).
 * @typedef {{ BackendState?: string; Self?: { DNSName?: string }; Peer?: Record<string, { Online?: boolean; DNSName?: string }> }} TailscaleStatus
 */

/** @returns {Promise<TailscaleStatus>} */
function tailscaleStatus() {
  const candidates = TAILSCALE[process.platform] ?? ["tailscale"];
  /**
   * @param {number} i
   * @returns {Promise<TailscaleStatus>}
   */
  const attempt = (i) =>
    new Promise((resolve, reject) => {
      execFile(candidates[i] ?? "tailscale", ["status", "--json"], { timeout: 5_000, maxBuffer: 16 << 20, windowsHide: true }, (error, stdout, stderr) => {
        if (!error) return resolve(JSON.parse(stdout));
        if (error.code === "ENOENT" && i + 1 < candidates.length) return resolve(attempt(i + 1));
        reject(new Error(error.code === "ENOENT" ? "Tailscale isn't installed on this computer." : String(stderr).trim() || error.message));
      });
    });
  return attempt(0);
}

/**
 * @param {string} dnsName
 * @param {boolean} self
 * @returns {Promise<import("../src/bridge.ts").FoundDaemon | undefined>}
 */
async function probe(dnsName, self) {
  const url = `wss://${dnsName}:${TAILNET_PORT}`;
  try {
    const response = await fetch(`https://${dnsName}:${TAILNET_PORT}/.well-known/top`, { signal: AbortSignal.timeout(4_000) });
    const body = await response.json();
    if (body?.top !== true) return undefined;
    const device = typeof body.device === "string" ? body.device : dnsName.split(".")[0];
    if (response.ok) return { device, url: typeof body.url === "string" ? body.url : url, self, serverId: body.serverId, state: "ok" };
    return { device, url, self, state: "refused", ...(typeof body.error === "string" ? { error: body.error } : {}) };
  } catch {
    return undefined; // no Top there, or the device didn't answer
  }
}

/** @returns {Promise<import("../src/bridge.ts").Discovery>} */
async function findTailnetDaemons() {
  let status;
  try {
    status = await tailscaleStatus();
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (status.BackendState !== "Running")
    return { ok: false, error: `Tailscale is ${status.BackendState === "NeedsLogin" ? "signed out" : "not running"} on this computer.` };
  const devices = [
    ...(status.Self?.DNSName ? [{ dnsName: status.Self.DNSName.replace(/\.$/, ""), self: true }] : []),
    ...Object.values(status.Peer ?? {}).flatMap((peer) => (peer.Online && peer.DNSName ? [{ dnsName: peer.DNSName.replace(/\.$/, ""), self: false }] : [])),
  ];
  const found = await Promise.all(devices.map((d) => probe(d.dnsName, d.self)));
  return { ok: true, daemons: found.filter((daemon) => daemon !== undefined) };
}

ipcMain.handle("top:tailnet", findTailnetDaemons);

app.whenReady().then(async () => {
  startUpdates(() => BrowserWindow.getAllWindows().map((w) => w.webContents));
  const win = createWindow();
  if (process.env.TOP_BENCH) {
    const { runBench } = await import("./bench-driver.js");
    // A failed run has to end the app, or whoever started it waits forever.
    await runBench(win).catch((/** @type {unknown} */ error) => {
      process.stdout.write(`BENCH:ERROR ${JSON.stringify(error instanceof Error ? error.message : String(error))}\n`);
      app.exit(1);
    });
  }
  app.on("activate", () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
