import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { build } from "esbuild";
import { BIN_TOP } from "../apps/server/src/installation.ts";
import { channelOf, daemonArchive } from "../packages/protocol/src/release.ts";

const NODE_VERSION = "26.13.0";

const root = resolve(import.meta.dirname, "..");
const { values } = parseArgs({ options: { channel: { type: "string" } } });
const version = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;
const channel = values.channel ?? channelOf(version) ?? "stable";
if (channel !== "stable" && channel !== "nightly") throw new Error("--channel stable|nightly");

const releaseDir = join(root, "release");
const name = `top-daemon-${version}-linux-x64`;
const out = join(releaseDir, name);
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "bin"), { recursive: true });

const step = (what: string) => console.log(`[build-daemon] ${what}`);

step(`bundling Top ${version} (${channel})`);
await build({
  entryPoints: [join(root, "apps/server/src/main.ts")],
  outfile: join(out, "server.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node26",
  sourcemap: "linked",
  define: { __TOP_VERSION__: JSON.stringify(version), __TOP_CHANNEL__: JSON.stringify(channel) },
  logLevel: "warning",
  plugins: [
    {
      name: "third-party-external",
      setup(b) {
        b.onResolve({ filter: /^[^./]/ }, (args) => (args.path.startsWith("@top/") ? undefined : { path: args.path, external: true }));
      },
    },
  ],
});

step("installing production dependencies");
const deployed = join(releaseDir, ".deploy");
rmSync(deployed, { recursive: true, force: true });
const workspaceState = join(root, "node_modules/.pnpm-workspace-state-v1.json");
const savedState = existsSync(workspaceState) ? readFileSync(workspaceState) : undefined;
try {
  execFileSync("pnpm", ["--filter", "@top/server", "deploy", "--prod", "--legacy", deployed], { cwd: root, stdio: "inherit" });
} finally {
  if (savedState) writeFileSync(workspaceState, savedState);
}
cpSync(join(deployed, "node_modules"), join(out, "node_modules"), { recursive: true, verbatimSymlinks: true });
rmSync(deployed, { recursive: true, force: true });
writeFileSync(join(out, "package.json"), `${JSON.stringify({ name: "top-daemon", version, private: true, type: "module" }, null, 2)}\n`);

const nodeName = `node-v${NODE_VERSION}-linux-x64`;
const cache = join(releaseDir, ".cache");
const nodeArchive = join(cache, `${nodeName}.tar.xz`);
mkdirSync(cache, { recursive: true });
const download = async (url: string) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
};
const sums = (await download(`https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt`)).toString("utf8");
const expected = sums
  .split("\n")
  .find((line) => line.endsWith(`  ${nodeName}.tar.xz`))
  ?.split(/\s+/)[0];
if (!expected) throw new Error(`No checksum for ${nodeName}.tar.xz`);
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
if (!existsSync(nodeArchive) || sha256(nodeArchive) !== expected) {
  step(`downloading Node ${NODE_VERSION}`);
  writeFileSync(nodeArchive, await download(`https://nodejs.org/dist/v${NODE_VERSION}/${nodeName}.tar.xz`));
  if (sha256(nodeArchive) !== expected) throw new Error(`${nodeName}.tar.xz doesn't match its checksum`);
}
mkdirSync(join(out, "node", "bin"), { recursive: true });
execFileSync("tar", ["-xJf", nodeArchive, "-C", join(out, "node"), "--strip-components=1", `${nodeName}/bin/node`, `${nodeName}/LICENSE`]);

writeFileSync(join(out, "bin", "top"), BIN_TOP);
chmodSync(join(out, "bin", "top"), 0o755);
const reported = execFileSync(join(out, "bin", "top"), ["--version"], { encoding: "utf8" }).trim();
if (!reported.includes(version)) throw new Error(`bin/top --version said "${reported}", not ${version}`);
step(`bin/top --version: ${reported}`);

const archive = join(releaseDir, daemonArchive(version));
execFileSync("tar", ["-czf", archive, "-C", releaseDir, name]);
step(`wrote ${archive}`);
