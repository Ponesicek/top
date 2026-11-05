// Electron main process. Deliberately thin: the renderer owns the socket and all state, so the
// same UI runs in a browser (pnpm web) and the main process never sits on the hot path.
import { app, BrowserWindow, nativeTheme, shell } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
if (process.env.TOP_USER_DATA) app.setPath("userData", process.env.TOP_USER_DATA);
if (process.env.TOP_THEME === "dark" || process.env.TOP_THEME === "light") nativeTheme.themeSource = process.env.TOP_THEME;
const devUrl = process.env.VITE_DEV_SERVER_URL;
const query = process.env.TOP_QUERY ?? "";

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 420,
    minHeight: 420,
    show: false,
    backgroundColor: "#0d0e11",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });
  win.once("ready-to-show", () => win.show());
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

app.whenReady().then(async () => {
  const win = createWindow();
  if (process.env.TOP_BENCH) {
    const { runBench } = await import("./bench-driver.js");
    await runBench(win);
  }
  app.on("activate", () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
