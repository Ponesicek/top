import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain, nativeTheme, shell } from "electron";
import { contextMenuItems, runContextMenuAction } from "./context-menu.js";
import { startUpdates } from "./updates.js";

const here = dirname(fileURLToPath(import.meta.url));
const topHome = process.env.TOP_HOME ? resolve(process.env.TOP_HOME.replace(/^~(?=$|\/)/, homedir())) : join(homedir(), ".top");
app.setPath("userData", process.env.TOP_USER_DATA ?? join(topHome, "desktop"));
if (process.env.TOP_THEME === "dark" || process.env.TOP_THEME === "light") nativeTheme.themeSource = process.env.TOP_THEME;
const devUrl = process.env.VITE_DEV_SERVER_URL;
const query = process.env.TOP_QUERY ?? "";
const headless = process.env.TOP_BENCH === "screenshot";

const overlay = () =>
  nativeTheme.shouldUseDarkColors ? { color: "#141413", symbolColor: "#eeedea", height: 40 } : { color: "#fefdfc", symbolColor: "#1a1917", height: 40 };

/** @type {WeakMap<Electron.WebContents, Electron.ContextMenuParams>} */
const lastRightClick = new WeakMap();

function createWindow() {
  const mac = process.platform === "darwin";
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 420,
    minHeight: 420,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#141413" : "#fefdfc",
    icon: join(here, "../assets/icons/512x512.png"),
    titleBarStyle: mac ? "hiddenInset" : "hidden",
    ...(mac ? {} : { titleBarOverlay: overlay() }),
    webPreferences: {
      preload: join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      plugins: true,
      ...(headless ? { backgroundThrottling: false } : {}),
    },
  });
  if (process.platform !== "darwin") {
    win.removeMenu();
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
    const recolor = () => !win.isDestroyed() && win.setTitleBarOverlay(overlay());
    nativeTheme.on("updated", recolor);
    win.on("closed", () => nativeTheme.off("updated", recolor));
  }
  if (!headless) win.once("ready-to-show", () => win.show());
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
  win.webContents.on("context-menu", (_event, params) => {
    const items = contextMenuItems(params);
    lastRightClick.delete(win.webContents);
    if (!items.length) return;
    lastRightClick.set(win.webContents, params);
    win.webContents.send("top:context-menu", { x: params.x, y: params.y, items });
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (url !== win.webContents.getURL()) event.preventDefault();
  });
  if (devUrl) void win.loadURL(devUrl + query);
  else void win.loadFile(join(here, "../dist/index.html"), { search: query.replace(/^\?/, "") });
  return win;
}

const TAILNET_PORT = 7357;
/** @type {Partial<Record<NodeJS.Platform, string[]>>} */
const TAILSCALE = {
  darwin: ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"],
  win32: ["tailscale", "C:\\Program Files\\Tailscale\\tailscale.exe"],
};

/** @typedef {{ BackendState?: string; Self?: { DNSName?: string }; Peer?: Record<string, { Online?: boolean; DNSName?: string }> }} TailscaleStatus */

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
    return undefined;
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

ipcMain.on("top:context-menu:run", (event, action) => {
  const params = lastRightClick.get(event.sender);
  if (!params || event.senderFrame !== event.sender.mainFrame) return;
  lastRightClick.delete(event.sender);
  runContextMenuAction(params, action, event.sender);
});

app.whenReady().then(async () => {
  startUpdates(() => BrowserWindow.getAllWindows().map((w) => w.webContents));
  const win = createWindow();
  if (process.env.TOP_BENCH) {
    const { runBench } = await import("./bench-driver.js");
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
