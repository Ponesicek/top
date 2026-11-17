import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Entry } from "@top/protocol";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { afterAll as after, test } from "vitest";
import { WebSocket } from "ws";
import { diff, makeFilesFolder, scan } from "../src/files.ts";
import { toWire } from "../src/wire.ts";
import { type Harness, harness, until } from "./harness.ts";

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function setup() {
  const h = await harness();
  return { h, folder: join(h.dir, "files"), bot: h.bot };
}

async function watched(h: Harness, bot: number, folder: string) {
  const entries: Entry[] = [];
  const scope = await h.run(Scope.make());
  const files = await h.run(
    makeFilesFolder(bot, folder, (_listing, entry) =>
      Effect.sync(() => {
        if (entry) entries.push(toWire(entry)!);
      }),
    ).pipe(Scope.provide(scope)),
  );
  return { files, entries, rescan: () => h.run(files.rescan), close: () => h.run(Scope.close(scope, Exit.void)) };
}

test("changes to the folder are reported as entries, and the first listing isn't", async () => {
  const { h, bot, folder } = await setup();
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "old.md"), "# there before");
  const { files, entries, rescan, close } = await watched(h, bot, folder);
  assert.equal(entries.length, 0, "what was there when the folder was first seen isn't news");
  assert.deepEqual([...files.listing().files.keys()], ["old.md"]);

  writeFileSync(join(folder, "report.html"), "<h1>hi</h1>");
  mkdirSync(join(folder, "site"));
  writeFileSync(join(folder, "site", "index.html"), "<p>site</p>");
  await rescan();
  writeFileSync(join(folder, "old.md"), "# changed, and longer");
  rmSync(join(folder, "report.html"));
  await rescan();
  await rescan();
  await close();

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
  const { h, bot, folder } = await setup();
  const first = await watched(h, bot, folder);
  await first.close();
  await h.close();

  writeFileSync(join(folder, "made-offline.txt"), "hello");
  const reopened = await harness({ dir: h.dir });
  const second = await watched(reopened, bot, folder);
  await second.close();
  assert.deepEqual(second.entries.length, 1);
  assert.deepEqual(second.entries[0]!.kind === "files" && second.entries[0]!.files, [{ path: "made-offline.txt", change: "added" }]);
});

test("files entries stay out of the model's context", async () => {
  const { h, bot, folder } = await setup();
  const { store } = h;
  await h.run(store.append(bot, "user", { role: "user", content: "hi", timestamp: 1 }));
  const { rescan, close } = await watched(h, bot, folder);
  writeFileSync(join(folder, "a.txt"), "a");
  await rescan();
  await close();
  assert.equal((await h.run(store.newest(bot, 10))).at(-1)!.kind, "files");
  assert.deepEqual(
    (await h.run(store.context(bot))).map((m) => m.role),
    ["user"],
  );
  assert.equal((await h.run(store.lastContextEntry(bot)))!.kind, "user");
});

test("hidden files and dependency folders aren't listed", async () => {
  const { h, folder } = await setup();
  mkdirSync(join(folder, ".git"), { recursive: true });
  mkdirSync(join(folder, "node_modules", "x"), { recursive: true });
  writeFileSync(join(folder, ".git", "HEAD"), "ref");
  writeFileSync(join(folder, "node_modules", "x", "index.js"), "");
  writeFileSync(join(folder, ".env"), "SECRET=1");
  writeFileSync(join(folder, "page.html"), "");
  assert.deepEqual([...(await h.run(scan(folder))).files.keys()], ["page.html"]);
  assert.deepEqual(diff(new Map([["a", { size: 1, mtime: 1 }]]), new Map([["a", { size: 1, mtime: 1 }]])), []);
});

test("files are served on the daemon's port, only with the secret and only inside the folder", async () => {
  const root = mkdtempSync(join(tmpdir(), "top-files-"));
  roots.push(root);
  const h = await harness({ files: (bot) => join(root, "bots", bot.name, "files"), serve: {} });
  const { store, bot, port } = h;
  const folder = (await until("the folder to be listed", () => h.daemon.files(bot))).folder;
  mkdirSync(join(folder, "site"), { recursive: true });
  writeFileSync(join(folder, "report.html"), "<h1>Report</h1>");
  writeFileSync(join(folder, "notes.md"), "# Notes");
  writeFileSync(join(folder, "site", "index.html"), "<p>site</p>");
  writeFileSync(join(folder, ".secret"), "no");
  writeFileSync(join(root, "outside.txt"), "no");

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
