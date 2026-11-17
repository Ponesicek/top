import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { build } from "esbuild";
import { channelOf, desktopAppImage, RELEASE_REPO } from "../packages/protocol/src/release.ts";

const root = resolve(import.meta.dirname, "..");
const desktop = join(root, "apps/desktop");
const { build: electronBuilder } = createRequire(join(desktop, "package.json"))("electron-builder") as typeof import("electron-builder");
const { values } = parseArgs({ options: { channel: { type: "string" } } });
const version = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;
const channel = values.channel ?? channelOf(version) ?? "stable";
if (channel !== "stable" && channel !== "nightly") throw new Error("--channel stable|nightly");
const step = (what: string) => console.log(`[build-desktop] ${what}`);

const releaseDir = join(root, "release");
const stage = join(releaseDir, ".desktop-stage");
rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, "electron"), { recursive: true });

step(`building the page for Top ${version} (${channel})`);
execFileSync("pnpm", ["exec", "vite", "build"], { cwd: desktop, stdio: "inherit" });
cpSync(join(desktop, "dist"), join(stage, "dist"), { recursive: true });

step("bundling the main process");
await build({
  entryPoints: [join(desktop, "electron/main.js")],
  outfile: join(stage, "electron/main.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["electron"],
  define: { __TOP_CHANNEL__: JSON.stringify(channel) },
  banner: { js: 'import { createRequire as __topRequire } from "node:module"; const require = __topRequire(import.meta.url);' },
  logLevel: "warning",
});
cpSync(join(desktop, "electron/preload.cjs"), join(stage, "electron/preload.cjs"));
cpSync(join(desktop, "assets/icons/512x512.png"), join(stage, "assets/icons/512x512.png"));
writeFileSync(
  join(stage, "package.json"),
  `${JSON.stringify(
    {
      name: "top",
      productName: "Top",
      version,
      description: "A fast, never-drops client for your bots",
      author: "Top",
      homepage: `https://github.com/${RELEASE_REPO}`,
      main: "electron/main.js",
      type: "module",
      desktopName: "top.desktop",
    },
    null,
    2,
  )}\n`,
);

step("packing the AppImage");
const [owner, repo] = RELEASE_REPO.split("/") as [string, string];
const electronDist = join(desktop, "node_modules/electron/dist");
if (!existsSync(electronDist)) {
  step("downloading Electron");
  execFileSync(process.execPath, [join(desktop, "node_modules/electron/install.js")], { cwd: join(desktop, "node_modules/electron"), stdio: "inherit" });
  if (!existsSync(electronDist)) throw new Error(`Electron didn't download (${electronDist} is missing)`);
}
const electronVersion = (JSON.parse(readFileSync(join(desktop, "node_modules/electron/package.json"), "utf8")) as { version: string }).version;
await electronBuilder({
  projectDir: stage,
  x64: true,
  linux: ["AppImage"],
  publish: "never",
  config: {
    appId: "io.github.ponesicek.top",
    productName: "Top",
    electronVersion,
    electronDist,
    directories: { output: releaseDir },
    files: ["electron/**", "dist/**", "assets/**", "package.json"],
    npmRebuild: false,
    nodeGypRebuild: false,
    asar: true,
    linux: {
      category: "Development",
      icon: join(desktop, "assets/icons"),
      // biome-ignore lint/suspicious/noTemplateCurlyInString: see above
      artifactName: "Top-${version}-x86_64.${ext}",
      synopsis: "A client for your bots",
    },
    publish: {
      provider: "github",
      owner,
      repo,
      channel: channel === "nightly" ? "nightly" : "latest",
      releaseType: channel === "nightly" ? "prerelease" : "release",
    },
  },
});
step(`wrote ${join(releaseDir, desktopAppImage(version))}`);
