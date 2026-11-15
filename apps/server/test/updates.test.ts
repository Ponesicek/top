/**
 * Updates: which release the daemon offers on each channel, and installing one from a stand-in for
 * GitHub (downloaded, checked, unpacked beside the running version, `current` moved, the database
 * backed up, and a planned restart), or refusing a damaged download.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CHECKSUMS, channelOf, compareVersions, daemonArchive, parseVersion, releaseNotes } from "@top/protocol";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { afterAll as after, test } from "vitest";
import { BUILD } from "../src/build.ts";
import * as Events from "../src/events.ts";
import { installLayout } from "../src/installation.ts";
import * as Sqlite from "../src/sqlite.ts";
import * as Store from "../src/store.ts";
import { checksumOf, type GitHubRelease, newestRelease, Updates, layer as updatesLayer } from "../src/updates.ts";

const cleanup: (() => Promise<void> | void)[] = [];
after(async () => {
  for (const fn of cleanup.reverse()) await fn();
});

const NIGHTLY = "0.1.0-nightly.20261114.3";
const STABLE = "0.1.0";

const release = (version: string, extra: Partial<GitHubRelease> = {}): GitHubRelease => ({
  tag_name: `v${version}`,
  html_url: `https://github.com/Ponesicek/Top/releases/tag/v${version}`,
  draft: false,
  prerelease: channelOf(version) === "nightly",
  body: "## What changed\n\n- Attach files to messages\n- Quote a bot's answers\n",
  assets: [
    { name: daemonArchive(version), browser_download_url: `https://example.com/${daemonArchive(version)}` },
    { name: CHECKSUMS, browser_download_url: "https://example.com/SHA256SUMS" },
  ],
  ...extra,
});

test("versions order like semver, a nightly before the stable release it leads to", () => {
  const sorted = ["0.2.0", "0.1.0", "0.2.0-nightly.20261114.2", "0.2.0-nightly.20261113.9", "0.2.0-nightly.20261114.10", "0.1.0-dev"].sort(compareVersions);
  assert.deepEqual(sorted, ["0.1.0-dev", "0.1.0", "0.2.0-nightly.20261113.9", "0.2.0-nightly.20261114.2", "0.2.0-nightly.20261114.10", "0.2.0"]);
  assert.equal(channelOf("v0.2.0"), "stable");
  assert.equal(channelOf("0.2.0-nightly.20261114.2"), "nightly");
  assert.equal(channelOf("0.2.0-dev"), undefined);
  assert.equal(parseVersion("0.2.0-beta.1"), undefined);
  assert.deepEqual(releaseNotes("Intro\n- One\n* Two\n\n-not a bullet"), ["One", "Two"]);
});

test("each channel is offered only its own newest published release, and only one with the daemon's files", () => {
  const releases = [
    release("0.2.0-nightly.20261115.1", { draft: true }),
    release("0.2.0-nightly.20261114.8", { assets: [] }),
    release("0.2.0-nightly.20261114.7"),
    release("0.2.0-nightly.20261113.6"),
    release("0.1.1"),
    release("0.1.0"),
  ];
  assert.equal(newestRelease(releases, "nightly", "0.2.0-nightly.20261113.6")?.version, "0.2.0-nightly.20261114.7");
  assert.equal(newestRelease(releases, "stable", "0.1.0")?.version, "0.1.1");
  // Nothing newer than what runs.
  assert.equal(newestRelease(releases, "stable", "0.1.1"), undefined);
  // A nightly ahead of every stable release: switching to Stable never goes back.
  assert.equal(newestRelease(releases, "stable", "0.2.0-nightly.20261114.7"), undefined);
  const offered = newestRelease(releases, "nightly", "0.1.0");
  assert.deepEqual(offered?.notes, ["Attach files to messages", "Quote a bot's answers"]);
  assert.equal(offered?.archiveUrl, `https://example.com/${daemonArchive("0.2.0-nightly.20261114.7")}`);
});

test("SHA256SUMS lines are read in both of sha256sum's modes", () => {
  const sums = `${"a".repeat(64)}  top-daemon-0.1.0-linux-x64.tar.gz\n${"B".repeat(64)} *Top-0.1.0-x86_64.AppImage\n`;
  assert.equal(checksumOf(sums, "top-daemon-0.1.0-linux-x64.tar.gz"), "a".repeat(64));
  assert.equal(checksumOf(sums, "Top-0.1.0-x86_64.AppImage"), "b".repeat(64));
  assert.equal(checksumOf(sums, "other"), undefined);
});

/** A stand-in for GitHub: the releases API, and release files behind a redirect, as GitHub serves them. */
async function github(work: string, options: { damaged?: boolean } = {}) {
  const archives = new Map<string, Buffer>();
  for (const version of [NIGHTLY, STABLE]) {
    const folder = join(work, "build", `top-daemon-${version}-linux-x64`);
    mkdirSync(join(folder, "bin"), { recursive: true });
    writeFileSync(join(folder, "bin", "top"), `#!/bin/sh\necho ${version}\n`, { mode: 0o755 });
    writeFileSync(join(folder, "server.mjs"), `// ${version}\n`);
    const archive = join(work, "build", daemonArchive(version));
    execFileSync("tar", ["-czf", archive, "-C", join(work, "build"), `top-daemon-${version}-linux-x64`]);
    archives.set(daemonArchive(version), readFileSync(archive));
  }
  const sums = [...archives]
    .map(([name, bytes]) => `${options.damaged ? "0".repeat(64) : createHash("sha256").update(bytes).digest("hex")}  ${name}`)
    .join("\n");

  let base = "";
  const server: Server = createServer((request, response) => {
    const url = request.url ?? "";
    if (url.startsWith("/repos/")) {
      const asset = (version: string) => [
        { name: daemonArchive(version), browser_download_url: `${base}/download/${daemonArchive(version)}` },
        { name: CHECKSUMS, browser_download_url: `${base}/download/${CHECKSUMS}` },
      ];
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify([release(NIGHTLY, { assets: asset(NIGHTLY) }), release(STABLE, { assets: asset(STABLE) })]));
    } else if (url.startsWith("/download/")) {
      response.writeHead(302, { location: url.replace("/download/", "/storage/") });
      response.end();
    } else if (url === `/storage/${CHECKSUMS}`) {
      response.end(sums);
    } else if (url.startsWith("/storage/") && archives.has(url.slice("/storage/".length))) {
      response.end(archives.get(url.slice("/storage/".length)));
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { releasesUrl: `${base}/repos/Ponesicek/Top/releases` };
}

async function setup(options: { damaged?: boolean; channel?: string } = {}) {
  const work = mkdtempSync(join(tmpdir(), "top-updates-"));
  cleanup.push(() => rmSync(work, { recursive: true, force: true }));
  const home = join(work, "home");
  const layout = installLayout(home);
  mkdirSync(join(home, "server"), { recursive: true });
  mkdirSync(layout.version(BUILD.version), { recursive: true });
  if (options.channel) {
    mkdirSync(layout.dir, { recursive: true });
    writeFileSync(layout.channel, `${options.channel}\n`);
  }
  const { releasesUrl } = await github(work, options);
  let restarts = 0;
  const storeLayer = Store.layer.pipe(Layer.provide(Sqlite.layer({ filename: join(home, "server", "top.sqlite") })));
  const runtime = ManagedRuntime.make(
    updatesLayer({ layout, releasesUrl, restart: Effect.sync(() => restarts++) }).pipe(
      Layer.provideMerge(Layer.mergeAll(storeLayer, Events.layer, NodeHttpClient.layerUndici, NodeServices.layer)),
    ),
  );
  cleanup.push(() => runtime.dispose());
  const updates = await runtime.runPromise(Effect.service(Updates));
  const store = await runtime.runPromise(Effect.service(Store.Store));
  return { runtime, updates, store, layout, home, restarts: () => restarts };
}

test("installing a release unpacks it beside the running one, moves `current`, backs up the data and restarts", async () => {
  const { runtime, updates, store, layout, home, restarts } = await setup({ channel: "nightly" });
  await runtime.runPromise(updates.check);
  const before = await runtime.runPromise(updates.view);
  assert.equal(before.channel, "nightly");
  assert.equal(before.state, "idle");
  assert.equal(before.available?.version, NIGHTLY);
  assert.deepEqual(before.available?.notes, ["Attach files to messages", "Quote a bot's answers"]);

  await runtime.runPromise(updates.install(NIGHTLY));
  assert.equal(restarts(), 1);
  assert.equal((await runtime.runPromise(updates.view)).state, "restarting");
  assert.ok(existsSync(join(layout.version(NIGHTLY), "bin", "top")));
  assert.equal(readlinkSync(layout.current), join("versions", NIGHTLY));
  assert.equal(readFileSync(layout.trial, "utf8"), `${NIGHTLY} ${BUILD.version} 0\n`);
  assert.ok(existsSync(join(home, "server", `top.sqlite.before-${NIGHTLY}`)));
  assert.equal(await runtime.runPromise(store.flag(Store.PLANNED_RESTART)), true);
  // Nothing half-done left behind.
  assert.equal(existsSync(join(layout.versions, `.unpacking-${NIGHTLY}`)), false);
  assert.equal(existsSync(join(layout.downloads, daemonArchive(NIGHTLY))), false);
});

test("a damaged download is refused, and nothing changes", async () => {
  const { runtime, updates, layout, restarts } = await setup({ damaged: true, channel: "nightly" });
  const failure = await runtime.runPromise(Effect.flip(updates.install(NIGHTLY)));
  assert.match(failure.message, /damaged/);
  assert.equal(restarts(), 0);
  assert.equal(existsSync(layout.current), false);
  assert.equal(existsSync(layout.version(NIGHTLY)), false);
  const view = await runtime.runPromise(updates.view);
  assert.equal(view.state, "failed");
  assert.match(view.error ?? "", /damaged/);
});

test("switching channels looks again on the new one, and remembers it", async () => {
  const { runtime, updates, layout } = await setup({ channel: "nightly" });
  await runtime.runPromise(updates.setChannel("stable"));
  const view = await runtime.runPromise(updates.view);
  assert.equal(view.channel, "stable");
  assert.equal(view.available?.version, STABLE);
  assert.equal(readFileSync(layout.channel, "utf8").trim(), "stable");
  // Only the release it offers can be installed.
  const refused = await runtime.runPromise(Effect.flip(updates.install(NIGHTLY)));
  assert.match(refused.message, /isn't the newest Stable release/);
});
