// pnpm screenshot [out.png]: start a daemon under load, open the production build, capture the window.
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const electron = require("electron");
const desktopDir = new URL("..", import.meta.url).pathname;
const serverMain = new URL("../../server/src/main.ts", import.meta.url).pathname;
const outPath = resolve(process.argv[2] ?? "screenshot.png");
const port = 7900 + Math.floor(Math.random() * 90);
const dataDir = mkdtempSync(join(tmpdir(), "top-shot-"));
const userData = mkdtempSync(join(tmpdir(), "top-shot-profile-"));

execFileSync("pnpm", ["exec", "vite", "build", "--logLevel", "error"], { cwd: desktopDir, stdio: "inherit" });
const server = spawn(process.execPath, [serverMain, "--port", String(port), "--data", dataDir, "--load", "--seed", "40"], { stdio: ["ignore", "pipe", "inherit"] });
await new Promise((r) => server.stdout.on("data", (d) => String(d).includes("listening") && r()));

const needsX = process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
const args = [".", ...(process.platform === "linux" ? ["--no-sandbox"] : [])];
const [cmd, cmdArgs] = needsX ? ["xvfb-run", ["-a", "-s", "-screen 0 1280x820x24", electron, ...args]] : [electron, args];
const child = spawn(cmd, cmdArgs, {
  cwd: desktopDir,
  stdio: ["pipe", "inherit", "ignore"],
  env: { ...process.env, TOP_BENCH: "screenshot", TOP_BENCH_T0: String(Date.now()), TOP_USER_DATA: userData, TOP_SHOT_PATH: outPath, TOP_QUERY: `?server=${encodeURIComponent(`ws://127.0.0.1:${port}`)}${process.env.TOP_SHOT_QUERY ?? ""}` },
});
await new Promise((r) => child.on("exit", r));
server.kill("SIGKILL");
rmSync(dataDir, { recursive: true, force: true });
rmSync(userData, { recursive: true, force: true });
console.log(outPath);
