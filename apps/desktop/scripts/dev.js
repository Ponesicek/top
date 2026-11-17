import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const require = createRequire(import.meta.url);
const electron = require("electron");

const server = await createServer({ configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)) });
await server.listen();
const url = server.resolvedUrls.local[0];
console.log(`[desktop] renderer at ${url}`);

const args = ["."];
if (process.platform === "linux") args.push("--no-sandbox");
const child = spawn(electron, args, {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  stdio: "inherit",
  env: { ...process.env, VITE_DEV_SERVER_URL: url },
});
child.on("exit", async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
