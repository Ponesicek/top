import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import type { Entry } from "@top/protocol";
import { afterAll as after, test } from "vitest";
import { WebSocket } from "ws";
import { Daemon } from "../src/daemon.ts";
import { createFakeModelProvider, FAKE_MODEL, FAKE_PROVIDER } from "../src/fake-bots.ts";
import { diff, FilesFolder, scan } from "../src/files.ts";
import { serve } from "../src/serve.ts";
import { Store } from "../src/store.ts";
import { toWire } from "../src/wire.ts";

const cleanup: (() => Promise<void> | void)[] = [];
after(async () => {
  for (const fn of cleanup.reverse()) await fn();
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "top-files-"));
  const dataPath = join(dir, "top.sqlite");
  const folder = join(dir, "files");
  const store = new Store(dataPath);
  const bot = store.createBot("Atlas", "", `${FAKE_PROVIDER}/${FAKE_MODEL}`);
  cleanup.push(() => {
    try {
      store.close();
    } catch {
      // the test closed it
    }
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, dataPath, folder, store, bot };
}

/** A watched folder whose reported entries are collected, as the daemon would announce them. */
function watched(store: Store, bot: number, folder: string) {
  const entries: Entry[] = [];
  const files = new FilesFolder(bot, folder, store, (_listing, entry) => entry && entries.push(toWire(entry)!));
  return { files, entries };
}

test("changes to the folder are reported as entries, and the first listing isn't", async () => {
  const { store, bot, folder } = setup();
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "old.md"), "# there before");
  const { files, entries } = watched(store, bot, folder);
  await files.start();
  assert.equal(entries.length, 0, "what was there when the folder was first seen isn't news");
  assert.deepEqual([...files.listing.files.keys()], ["old.md"]);

  writeFileSync(join(folder, "report.html"), "<h1>hi</h1>");
  mkdirSync(join(folder, "site"));
  writeFileSync(join(folder, "site", "index.html"), "<p>site</p>");
  await files.rescan();
  writeFileSync(join(folder, "old.md"), "# changed, and longer");
  rmSync(join(folder, "report.html"));
  await files.rescan();
  await files.rescan();
  files.close();
  store.close();

  assert.deepEqual(
    entries.map((e) => (e.kind === "files" ? e.files : e)),
    [
      [
        { path: "report.html", change: "added" },
        { path: "site/index.html", change: "added" },
      ],
      [
        { path: "old.md", change: "changed" },
        { path: "report.html", change: "removed" },
      ],
    ],
  );
});

test("a change made while the daemon was down is reported when it starts", async () => {
  const { store, bot, folder, dataPath } = setup();
  const first = watched(store, bot, folder);
  await first.files.start();
  first.files.close();
  store.close();

  writeFileSync(join(folder, "made-offline.txt"), "hello");
  const reopened = new Store(dataPath);
  const second = watched(reopened, bot, folder);
  await second.files.start();
  second.files.close();
  reopened.close();
  assert.deepEqual(second.entries.length, 1);
  assert.deepEqual(second.entries[0]!.kind === "files" && second.entries[0]!.files, [{ path: "made-offline.txt", change: "added" }]);
});

test("files entries stay out of the model's context", async () => {
  const { store, bot, folder } = setup();
  store.append(bot, "user", { role: "user", content: "hi", timestamp: 1 });
  const { files } = watched(store, bot, folder);
  await files.start();
  writeFileSync(join(folder, "a.txt"), "a");
  await files.rescan();
  files.close();
  assert.equal(store.newest(bot, 10).at(-1)!.kind, "files");
  assert.deepEqual(
    store.context(bot).map((e) => e.kind),
    ["user"],
  );
  assert.equal(store.lastContextEntry(bot)!.kind, "user");
  store.close();
});

test("hidden files and dependency folders aren't listed", async () => {
  const { folder } = setup();
  mkdirSync(join(folder, ".git"), { recursive: true });
  mkdirSync(join(folder, "node_modules", "x"), { recursive: true });
  writeFileSync(join(folder, ".git", "HEAD"), "ref");
  writeFileSync(join(folder, "node_modules", "x", "index.js"), "");
  writeFileSync(join(folder, ".env"), "SECRET=1");
  writeFileSync(join(folder, "page.html"), "");
  assert.deepEqual([...(await scan(folder)).files.keys()], ["page.html"]);
  assert.deepEqual(diff(new Map([["a", { size: 1, mtime: 1 }]]), new Map([["a", { size: 1, mtime: 1 }]])), []);
});

test("files are served on the daemon's port, only with the secret and only inside the folder", async () => {
  const { dir, store } = setup();
  const models = createModels();
  models.setProvider(createFakeModelProvider(1_000).provider);
  const daemon = new Daemon(store, models, [], { files: (bot) => join(dir, "bots", bot.name, "files") });
  const bot = store.bots()[0]!.id;
  const folder = daemon.files(bot)!.folder;
  mkdirSync(join(folder, "site"), { recursive: true });
  writeFileSync(join(folder, "report.html"), "<h1>Report</h1>");
  writeFileSync(join(folder, "notes.md"), "# Notes");
  writeFileSync(join(folder, "site", "index.html"), "<p>site</p>");
  writeFileSync(join(folder, ".secret"), "no");
  writeFileSync(join(dir, "outside.txt"), "no");
  const server = serve(daemon, { host: "127.0.0.1", port: 0, compress: false });
  const port = await server.listening;
  cleanup.push(async () => {
    await server.close();
    daemon.closeFiles();
    store.close();
  });

  const base = `http://127.0.0.1:${port}/files/${store.filesSecret}/${bot}`;
  const page = await fetch(`${base}/report.html`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(page.headers.get("referrer-policy"), "no-referrer");
  assert.equal(page.headers.get("access-control-allow-origin"), "*");
  assert.equal(await page.text(), "<h1>Report</h1>");

  const etag = page.headers.get("etag")!;
  assert.equal((await fetch(`${base}/report.html`, { headers: { "If-None-Match": etag } })).status, 304);
  assert.equal(await (await fetch(`${base}/notes.md`, { headers: { Range: "bytes=2-" } })).text(), "Notes");
  assert.equal(await (await fetch(`${base}/site/`)).text(), "<p>site</p>");
  assert.equal((await fetch(`${base}/site`, { redirect: "manual" })).status, 301);

  for (const path of ["/.secret", "/..%2Foutside.txt", "/../outside.txt", "/%2e%2e/outside.txt", "/missing.html"]) {
    assert.equal((await fetch(`${base}${path}`)).status, 404, path);
  }
  assert.equal((await fetch(`http://127.0.0.1:${port}/files/wrong-secret/${bot}/report.html`)).status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${port}/files/${store.filesSecret}/999/report.html`)).status, 404);

  // A bot's page runs at the daemon's own address, and a sandboxed frame inside it (or inside any web
  // page) says Origin: null. Neither may open the daemon's WebSocket; the app may.
  const opens = (origin: string) =>
    new Promise<boolean>((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}`, { origin });
      socket.on("open", () => {
        socket.close();
        resolve(true);
      });
      socket.on("error", () => resolve(false));
    });
  assert.equal(await opens(`http://127.0.0.1:${port}`), false);
  assert.equal(await opens("null"), false);
  assert.equal(await opens("file://"), true);
});
