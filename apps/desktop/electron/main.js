// Electron main process. Deliberately thin: the renderer owns the socket and all state, so the
// same UI runs in a browser (pnpm web) and the main process never sits on the hot path.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, nativeTheme, shell } from "electron";

const here = dirname(fileURLToPath(import.meta.url));
if (process.env.TOP_USER_DATA) app.setPath("userData", process.env.TOP_USER_DATA);
if (process.env.TOP_THEME === "dark" || process.env.TOP_THEME === "light") nativeTheme.themeSource = process.env.TOP_THEME;
const devUrl = process.env.VITE_DEV_SERVER_URL;
const query = process.env.TOP_QUERY ?? "";
/** `pnpm screenshot` captures the page without ever putting a window on screen. */
const headless = process.env.TOP_BENCH === "screenshot";

/**
 * No title bar: the app's own header and sidebar are the window's drag areas. macOS keeps its traffic
 * lights inset; Windows and Linux keep their window buttons, drawn over the header's top-right corner
 * in the app's own background (`--background` in styles.css) and text colors.
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
      // Screenshots render in a window that is never shown, so it must keep painting while hidden.
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
