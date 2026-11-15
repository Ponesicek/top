/**
 * The desktop app as a Linux x64 AppImage, with the update feed electron-updater reads:
 *
 *   release/Top-<version>-x86_64.AppImage
 *   release/latest-linux.yml        (stable)   or   release/nightly-linux.yml   (nightly)
 *
 *   pnpm build:desktop [--channel stable|nightly]     the version is the root package.json's
 *
 * The page is built by Vite (which bundles every dependency it has), and the main process by esbuild
 * (with electron-updater), into a staging folder with nothing else in it. electron-builder packs that,
 * so pnpm's node_modules never come near it.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { build } from "esbuild";
import { channelOf, desktopAppImage, RELEASE_REPO } from "../packages/protocol/src/release.ts";

const root = resolve(import.meta.dirname, "..");
const desktop = join(root, "apps/desktop");
// electron-builder is the desktop app's dependency, not the workspace's.
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
  // electron-updater is CommonJS; its requires of Node's modules need a `require` in an ES module.
  banner: { js: 'import { createRequire as __topRequire } from "node:module"; const require = __topRequire(import.meta.url);' },
  logLevel: "warning",
});
cpSync(join(desktop, "electron/preload.cjs"), join(stage, "electron/preload.cjs"));
// The window's own icon (electron/main.js reads it), for when no launcher supplies one.
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
      // The window's app id, so desktops match it to the AppImage's launcher.
      desktopName: "top.desktop",
    },
    null,
    2,
  )}\n`,
);

step("packing the AppImage");
const [owner, repo] = RELEASE_REPO.split("/") as [string, string];
const electronDist = join(desktop, "node_modules/electron/dist");
if (!existsSync(electronDist))
  throw new Error(`Electron isn't downloaded (${electronDist} is missing). Run: node ${join(desktop, "node_modules/electron/install.js")}`);
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
      // One PNG per size (apps/desktop/scripts/icon.js draws them); electron-builder packs a single picture as it is.
      icon: join(desktop, "assets/icons"),
      // electron-builder's own placeholders, not a template string.
      // biome-ignore lint/suspicious/noTemplateCurlyInString: see above
      artifactName: "Top-${version}-x86_64.${ext}",
      synopsis: "A client for your bots",
    },
    // Writes the update feed (latest-linux.yml or nightly-linux.yml) and app-update.yml inside the app.
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
