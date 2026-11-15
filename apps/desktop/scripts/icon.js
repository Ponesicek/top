// pnpm --filter @top/desktop icon: draw assets/icon.svg as assets/icons/<size>x<size>.png, the set the
// AppImage and the window use. Run it after changing the SVG. Electron does the drawing, because it is
// the one renderer the repo already has: under Node this file starts Electron on itself.

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

/** The sizes Linux desktops look for; each is drawn from the SVG, not scaled down from a larger one. */
const SIZES = [16, 24, 32, 48, 64, 128, 256, 512];
const svgPath = fileURLToPath(new URL("../assets/icon.svg", import.meta.url));
const outDir = fileURLToPath(new URL("../assets/icons", import.meta.url));

if (!process.versions.electron) {
  const electron = createRequire(import.meta.url)("electron");
  const args = [fileURLToPath(import.meta.url), "--force-device-scale-factor=1", ...(process.platform === "linux" ? ["--no-sandbox"] : [])];
  const needsX = process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
  const [cmd, cmdArgs] = needsX ? ["xvfb-run", ["-a", electron, ...args]] : [electron, args];
  const { status } = spawnSync(cmd, cmdArgs, { stdio: "inherit" });
  if (status === 0) console.log(outDir);
  process.exit(status ?? 1);
}

const { app, BrowserWindow } = await import("electron");
// Not `await app.whenReady()`: Electron holds "ready" until this module has finished loading.
void draw().catch((error) => {
  console.error(error);
  app.exit(1);
});

async function draw() {
  await app.whenReady();
  const win = new BrowserWindow({ show: false });
  await win.loadURL("about:blank");
  // Through a canvas, not a capture of the window, so the corners outside the tile stay clear.
  const svg = `data:image/svg+xml;base64,${readFileSync(svgPath).toString("base64")}`;
  const pngs = await win.webContents.executeJavaScript(`new Promise((done, fail) => {
    const image = new Image();
    image.onload = () =>
      done(${JSON.stringify(SIZES)}.map((size) => {
        const canvas = Object.assign(document.createElement("canvas"), { width: size, height: size });
        canvas.getContext("2d").drawImage(image, 0, 0, size, size);
        return canvas.toDataURL("image/png");
      }));
    image.onerror = () => fail(new Error("the SVG did not load"));
    image.src = ${JSON.stringify(svg)};
  })`);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir);
  for (const [i, size] of SIZES.entries()) writeFileSync(`${outDir}/${size}x${size}.png`, Buffer.from(pngs[i].slice(pngs[i].indexOf(",") + 1), "base64"));
  app.quit();
}
