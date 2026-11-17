import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const host = "127.0.0.1";
const daemonFlags = process.argv.length > 2 ? process.argv.slice(2) : ["--load", "--tools", "--seed", "40"];

const freePort = () =>
  new Promise<number>((done, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, host, () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address ? done(address.port) : fail(new Error("no port"))));
    });
  });

const daemonPort = await freePort();
const webPort = await freePort();
const web = `http://${host}:${webPort}`;
const children: ChildProcess[] = [];

function start(name: string, cwd: string, args: string[], ready: RegExp) {
  const child = spawn(process.execPath, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  return new Promise<void>((done, fail) => {
    const relay = (chunk: Buffer, to: NodeJS.WriteStream) => {
      for (const line of String(chunk).split("\n")) {
        if (!line.trim()) continue;
        to.write(`[${name}] ${line}\n`);
        if (ready.test(line)) done();
      }
    };
    child.stdout?.on("data", (chunk: Buffer) => relay(chunk, process.stdout));
    child.stderr?.on("data", (chunk: Buffer) => relay(chunk, process.stderr));
    child.once("exit", (code, signal) => {
      fail(new Error(`${name} stopped before it was ready (${signal ?? `exit code ${code}`})`));
      stop(code ?? 1);
    });
  });
}

let stopping = false;
function stop(code: number) {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 1_500).unref();
  Promise.all(children.map((child) => (child.exitCode !== null || child.signalCode !== null ? undefined : new Promise((r) => child.once("exit", r))))).then(
    () => process.exit(code),
  );
}
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

try {
  await start(
    "daemon",
    resolve(root, "apps/server"),
    ["--import", "tsx", "src/main.ts", "--port", String(daemonPort), "--allow-origin", web, ...daemonFlags],
    /listening on/,
  );
  await start("web", resolve(root, "apps/desktop"), ["node_modules/vite/bin/vite.js", "--host", host, "--port", String(webPort), "--strictPort"], /ready in/);
} catch (error) {
  console.error(`[dev:fake] ${error instanceof Error ? error.message : String(error)}`);
  stop(1);
}
if (!stopping) {
  console.log(`[dev:fake] fake bots: ${daemonFlags.join(" ")}; state in apps/server/.data/fake`);
  console.log(`url: ${web}/?server=ws://${host}:${daemonPort}`);
  console.log(`pid: ${process.pid}`);
}
