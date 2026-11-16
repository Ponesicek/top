// pnpm bench: measure the desktop app against the UX bar, end to end, with the real daemon.
//
//   daemon: fresh data, 5 bots under synthetic load (100 tok/s each), one bot seeded with 10,000 messages
//   app:    production build in Electron, driven with real input events
//
// Prints a table and writes bench-results.json.

import { execSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const electron = require("electron");
const desktopDir = fileURLToPath(new URL("..", import.meta.url));
const serverMain = fileURLToPath(new URL("../../server/src/main.ts", import.meta.url));
const port = 7600 + Math.floor(Math.random() * 300);
const dataDir = mkdtempSync(join(tmpdir(), "top-bench-data-"));
const userData = mkdtempSync(join(tmpdir(), "top-bench-profile-"));

console.log("[bench] building renderer…");
// One command string: pnpm is a .cmd shim on Windows, which Node runs only through a shell.
execSync("pnpm exec vite build --logLevel error", { cwd: desktopDir, stdio: "inherit" });

let server;
function startServer(extra = []) {
  return new Promise((resolve, reject) => {
    server = spawn(process.execPath, ["--import", "tsx", serverMain, "--port", String(port), "--home", dataDir, "--load", ...extra], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    server.stdout.on("data", (d) => String(d).includes("listening") && resolve());
    server.on("exit", (code) => code && code !== 0 && reject(new Error(`daemon exited ${code}`)));
  });
}
const killServer = () =>
  new Promise((r) => {
    if (!server || server.exitCode !== null) return r();
    server.once("exit", r);
    server.kill("SIGKILL");
  });

function runElectron(mode) {
  return new Promise((resolve, reject) => {
    const needsX = process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
    const args = [".", ...(process.platform === "linux" ? ["--no-sandbox"] : [])];
    const [cmd, cmdArgs] = needsX ? ["xvfb-run", ["-a", "-s", "-screen 0 1280x820x24", electron, ...args]] : [electron, args];
    const child = spawn(cmd, cmdArgs, {
      cwd: desktopDir,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        TOP_BENCH: mode,
        TOP_BENCH_T0: String(Date.now()),
        TOP_USER_DATA: userData,
        TOP_QUERY: `?server=${encodeURIComponent(`ws://127.0.0.1:${port}`)}&bench`,
      },
    });
    let result;
    let buffer = "";
    child.stdout.on("data", async (chunk) => {
      buffer += chunk;
      for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.startsWith("BENCH:KILL")) await killServer();
        else if (line.startsWith("BENCH:RESTART")) {
          await new Promise((r) => setTimeout(r, 1_000));
          await startServer();
          child.stdin.write("RESTARTED\n");
        } else if (line.startsWith("BENCH:RESULT ")) result = JSON.parse(line.slice(13));
      }
    });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.on("exit", () => (result ? resolve(result) : reject(new Error(`electron exited without a result\n${stderr.slice(-3000)}`))));
  });
}

const fmt = (n) => (n === undefined ? "–" : `${Math.round(n * 10) / 10}`);
const row = (name, value, bar, pass) => console.log(`${pass ? "✔" : "✘"} ${name.padEnd(46)} ${value.padStart(14)}   bar: ${bar}`);

try {
  console.log("[bench] starting daemon (5 bots under load, 10,000-message history)…");
  await startServer(["--seed", "10000", "--tps", "100"]);
  console.log("[bench] run 1: empty cache, typing, scrolling, kill -9…");
  const full = await runElectron("full");
  console.log("[bench] run 2: cold start from the local cache…");
  const warm = await runElectron("coldstart");

  console.log("");
  row("Cold start, empty cache → content", `${fmt(full.coldStartMs)} ms`, "< 1000 ms", full.coldStartMs < 1000);
  row("Cold start, cached → content", `${fmt(warm.coldStartMs)} ms`, "< 1000 ms", warm.coldStartMs < 1000);
  const t = full.typing;
  row(`Keystroke → frame p50 (${t.botsBusyAtStart} bots busy)`, `${fmt(t.inputP50)} ms`, "< 16.7 ms", t.inputP50 < 16.7);
  row(`Keystroke → frame p99`, `${fmt(t.inputP99)} ms`, "next frame (≤ 20.7 ms)", t.inputP99 <= 20.7);
  row(`Keystrokes that missed the next frame`, `${t.inputMissedFrame} / ${t.inputSamples}`, "< 1%", t.inputMissedFrame / t.inputSamples < 0.01);
  row(`Frames while typing, bots working, p99`, `${fmt(t.frameP99)} ms`, "≤ 20 ms (60 fps)", t.frameP99 <= 20);
  const s = full.scroll;
  row(`Scroll 10k transcript: avg fps`, fmt(s.fps), "≥ 58", s.fps >= 58);
  row(`Scroll 10k transcript: frame p99`, `${fmt(s.frameP99)} ms`, "≤ 20 ms", s.frameP99 <= 20);
  row(`Scroll: frames over 33 ms`, String(s.framesOver33ms), "0", s.framesOver33ms === 0);
  const r = full.reconnect;
  row(
    `kill -9: last known state kept`,
    `${r.staleShown ? "yes" : "no"}, ${r.rowsKeptWhileDown} rows`,
    "no blank screen",
    r.staleShown && r.rowsKeptWhileDown > 0,
  );
  row(`Reconnect after daemon restart`, `${fmt(r.reconnectAfterRestartMs)} ms`, "< 1000 ms", r.reconnectAfterRestartMs < 1000);
  row(
    `Offline message durably accepted after restart`,
    `${fmt(r.offlineMessageAcceptedAfterRestartMs)} ms`,
    "< 1500 ms",
    r.offlineMessageAcceptedAfterRestartMs < 1500,
  );
  row(`Copies of the offline message`, String(r.copiesOfOfflineMessage), "exactly 1", r.copiesOfOfflineMessage === 1);
  console.log(
    `\n  offline message placed in the transcript ${fmt(r.offlineMessagePlacedAfterRestartMs)} ms after restart (it queues behind the bot's resumed turn)`,
  );
  console.log(
    `  scroll covered ${Math.round(s.scrolledPx)} px, ${s.itemsLoaded} entries loaded, ${s.rowsInDom} rows in the DOM; long tasks: typing ${t.longTasks}, scroll ${s.longTasks}`,
  );
  const out = join(desktopDir, "bench-results.json");
  writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), platform: process.platform, xvfb: !process.env.DISPLAY, full, warm }, null, 2));
  console.log(`  raw numbers: ${out}`);
} finally {
  await killServer();
  rmSync(dataDir, { recursive: true, force: true });
  if (existsSync(userData)) rmSync(userData, { recursive: true, force: true });
}
