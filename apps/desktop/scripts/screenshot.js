// pnpm screenshot [out.png]: start a daemon under load, open the production build, capture the window.

import { execSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const electron = require("electron");
const desktopDir = fileURLToPath(new URL("..", import.meta.url));
const serverMain = fileURLToPath(new URL("../../server/src/main.ts", import.meta.url));
const outPath = resolve(process.argv[2] ?? "screenshot.png");
const port = 7900 + Math.floor(Math.random() * 90);
const dataDir = mkdtempSync(join(tmpdir(), "top-shot-"));
const userData = mkdtempSync(join(tmpdir(), "top-shot-profile-"));

// One command string: pnpm is a .cmd shim on Windows, which Node runs only through a shell.
execSync("pnpm exec vite build --logLevel error", { cwd: desktopDir, stdio: "inherit" });
const server = spawn(process.execPath, ["--import", "tsx", serverMain, "--port", String(port), "--data", dataDir, "--load", "--tools", "--seed", "40"], {
  stdio: ["ignore", "pipe", "inherit"],
});
await new Promise((r) => server.stdout.on("data", (d) => String(d).includes("listening") && r()));

const needsX = process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
// TOP_SHOT_SCALE=2 captures at 2x, like a hi-DPI screen.
const scale = Number(process.env.TOP_SHOT_SCALE ?? 1);
const args = [".", ...(process.platform === "linux" ? ["--no-sandbox"] : []), ...(scale !== 1 ? [`--force-device-scale-factor=${scale}`] : [])];
const screen = `${Math.ceil(1280 * scale)}x${Math.ceil(820 * scale)}x24`;
const [cmd, cmdArgs] = needsX ? ["xvfb-run", ["-a", "-s", `-screen 0 ${screen}`, electron, ...args]] : [electron, args];
const child = spawn(cmd, cmdArgs, {
  cwd: desktopDir,
  stdio: ["pipe", "inherit", "ignore"],
  env: {
    ...process.env,
    TOP_BENCH: "screenshot",
    TOP_BENCH_T0: String(Date.now()),
    TOP_USER_DATA: userData,
    TOP_SHOT_PATH: outPath,
    TOP_QUERY: `?server=${encodeURIComponent(`ws://127.0.0.1:${port}`)}${process.env.TOP_SHOT_QUERY ?? ""}`,
  },
});
await new Promise((r) => child.on("exit", r));
server.kill("SIGKILL");
// Windows keeps the daemon's files locked until it has exited.
await new Promise((r) => (server.exitCode !== null || server.signalCode !== null ? r() : server.once("exit", r)));
rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 });
rmSync(userData, { recursive: true, force: true });
console.log(outPath);
