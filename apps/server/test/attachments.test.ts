/**
 * Attachments: uploads over HTTP, what the daemon decides each file is, a message claiming them, what
 * the bot gets (its text, a path per file, images as images) and what clients see, and cleanup.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { type Attachment, MAX_ATTACHMENT_BYTES } from "@top/protocol";
import { Attachments, cleanName, withImageData } from "../src/attachments.ts";
import { Daemon } from "../src/daemon.ts";
import { createFakeModelProvider, FAKE_MODEL, FAKE_PROVIDER } from "../src/fake-bots.ts";
import { serve } from "../src/serve.ts";
import { Store } from "../src/store.ts";
import { toWire } from "../src/wire.ts";

const cleanup: (() => Promise<void> | void)[] = [];
after(async () => {
  for (const fn of cleanup.reverse()) await fn();
});

/** A 1×1 PNG. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

async function setup(names = ["Atlas"]) {
  const dir = mkdtempSync(join(tmpdir(), "top-attach-"));
  const store = new Store(join(dir, "top.sqlite"));
  for (const name of names) store.createBot(name, "", `${FAKE_PROVIDER}/${FAKE_MODEL}`);
  const models = createModels();
  models.setProvider(createFakeModelProvider(5_000).provider);
  const attachments = new Attachments(dir, store);
  const daemon = new Daemon(store, models, [], { attachments, gatherMs: 50 });
  const server = serve(daemon, { host: "127.0.0.1", port: 0, compress: false });
  const port = await server.listening;
  cleanup.push(async () => {
    await server.close();
    daemon.close();
    attachments.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}/attachments/${store.filesSecret}`;
  const upload = async (name: string, type: string, body: Buffer) => {
    const response = await fetch(`${base}/upload?name=${encodeURIComponent(name)}`, { method: "POST", headers: { "Content-Type": type }, body });
    return { status: response.status, body: response.ok ? ((await response.json()) as Attachment) : await response.text() };
  };
  return { dir, store, daemon, attachments, base, upload, bot: store.bots()[0]!.id, bots: store.bots().map((b) => b.id) };
}

async function until<T>(what: string, check: () => T | undefined | false, timeoutMs = 5_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("an upload is stored under its own name, and an image type is believed only when the bytes agree", async () => {
  const { upload, attachments, base } = await setup();
  const png = await upload("shot.png", "image/png", PNG);
  assert.equal(png.status, 200);
  const image = png.body as Attachment;
  assert.equal(image.mimeType, "image/png");
  assert.equal(image.size, PNG.length);
  assert.match(image.id, /^[A-Za-z0-9_-]{16}$/);
  assert.deepEqual(readFileSync(attachments.path(image)), PNG);
  assert.ok(attachments.path(image).endsWith(`${image.id}/shot.png`));

  // Not a PNG, whatever it says: never given to a model as an image.
  const fake = (await upload("fake.png", "image/png", Buffer.from("not a png at all"))).body as Attachment;
  assert.equal(fake.mimeType, "application/octet-stream");
  // No type, but the bytes are a PNG.
  assert.equal(((await upload("paste", "", PNG)).body as Attachment).mimeType, "image/png");
  // A name can't leave its folder.
  const sneaky = (await upload("../../etc/passwd", "text/plain", Buffer.from("x"))).body as Attachment;
  assert.equal(sneaky.name, "_.._etc_passwd");

  // Served with its type, cached for good, and sandboxed.
  const served = await fetch(`${base}/${image.id}`);
  assert.equal(served.headers.get("content-type"), "image/png");
  assert.match(served.headers.get("content-security-policy") ?? "", /sandbox/);
  assert.match(served.headers.get("cache-control") ?? "", /immutable/);
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), PNG);
  // Unknown types download instead of rendering.
  const blob = (await upload("data.bin", "application/x-thing", Buffer.from([1, 2, 3]))).body as Attachment;
  const download = await fetch(`${base}/${blob.id}`);
  assert.equal(download.headers.get("content-type"), "application/octet-stream");
  assert.match(download.headers.get("content-disposition") ?? "", /^attachment;/);
  // A wrong secret finds nothing.
  assert.equal((await fetch(`${base.replace(/[^/]+$/, "nope")}/${image.id}`)).status, 404);
});

test("uploads that are empty or too large are refused", async () => {
  const { upload, base } = await setup();
  const empty = await upload("empty.txt", "text/plain", Buffer.alloc(0));
  assert.equal(empty.status, 400);
  assert.match(String(empty.body), /empty/);
  // Refused from its length alone, before any bytes are read.
  const { request } = await import("node:http");
  const status = await new Promise<number>((resolve, reject) => {
    const req = request(`${base}/upload?name=big.bin`, { method: "POST", headers: { "Content-Length": String(MAX_ATTACHMENT_BYTES + 1) } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
  assert.equal(status, 413);
});

test("a message with attachments gives the bot their paths and the images, and clients what the user sent", async () => {
  const { daemon, store, upload, attachments, bot } = await setup();
  await daemon.start();
  const image = (await upload("shot.png", "image/png", PNG)).body as Attachment;
  const notes = (await upload("notes.txt", "text/plain", Buffer.from("hello"))).body as Attachment;
  daemon.submit(bot, "r1", "What is in these?", "followUp", null, [image.id, notes.id]);
  // Queued: the inbox keeps them, so they survive a restart.
  const placed = await until("the message to reach the bot", () => store.after(bot, 0, 100).find((e) => e.kind === "user"));
  await until("the answer", () => store.after(bot, 0, 100).some((e) => e.kind === "assistant"));

  // Clients see the text and the attachments, not the note for the bot.
  const wire = toWire(placed);
  assert.equal(wire?.kind, "user");
  assert.equal(wire?.kind === "user" && wire.text, "What is in these?");
  assert.deepEqual(wire?.kind === "user" && wire.attachments, [image, notes]);

  // The stored message holds the image by id only; each request reads its bytes in.
  const message = JSON.parse(placed.message) as { content: { type: string; text?: string; data?: string; attachment?: string }[] };
  assert.equal(message.content[0]!.text, "What is in these?");
  assert.match(message.content[1]!.text!, /\[Attached image "shot\.png" \(image\/png, \d+ B\) is saved at: .*shot\.png\]/);
  assert.match(message.content[1]!.text!, /\[Attached file "notes\.txt" \(text\/plain, 5 B\) is saved at: .*notes\.txt\]/);
  assert.deepEqual(message.content[2], { type: "image", mimeType: "image/png", data: "", attachment: image.id });
  const [hydrated] = await withImageData([message], attachments);
  assert.equal((hydrated!.content[2] as { data: string }).data, PNG.toString("base64"));

  // An image whose file is gone becomes a note rather than a broken image.
  rmSync(join(attachments.root, image.id), { recursive: true });
  const fresh = new Attachments(join(attachments.root, ".."), store);
  cleanup.push(() => fresh.close());
  const [gone] = await withImageData([message], fresh);
  assert.deepEqual(gone!.content[2], { type: "text", text: '[The image "shot.png" is no longer available.]' });
});

test("a message can't use another bot's attachments, ones that don't exist, or carry nothing at all", async () => {
  const { daemon, store, upload, bot, bots } = await setup(["Atlas", "Moss"]);
  const other = bots[1]!;
  await daemon.start();
  const file = (await upload("a.txt", "text/plain", Buffer.from("a"))).body as Attachment;
  daemon.submit(bot, "r1", "", "followUp", null, [file.id]);
  assert.throws(() => daemon.submit(other, "r2", "mine?", "followUp", null, [file.id]), { name: "AttachmentError", message: /attach it again/ });
  assert.throws(() => daemon.submit(bot, "r3", "hi", "followUp", null, ["AAAAAAAAAAAAAAAA"]), { name: "AttachmentError" });
  assert.throws(() => daemon.submit(bot, "r4", "  ", "followUp", null, []), { name: "AttachmentError", message: /empty/ });
  await until("the bot to finish", () => !daemon.runner(bot).busy && store.inbox(bot).length === 0);
});

test("a deleted bot's attachments go with it, and folders the store doesn't know are swept", async () => {
  const { daemon, upload, attachments, bot } = await setup();
  const file = (await upload("a.txt", "text/plain", Buffer.from("a"))).body as Attachment;
  daemon.submit(bot, "r1", "keep this", "followUp", null, [file.id]);
  assert.ok(existsSync(attachments.path(file)));
  daemon.deleteBot(bot);
  await until("the file to go", () => !existsSync(attachments.path(file)));

  const stray = join(attachments.root, "strayFolder00000");
  mkdirSync(stray, { recursive: true });
  const old = new Date(Date.now() - 2 * 60 * 60_000);
  utimesSync(stray, old, old);
  await attachments.sweep();
  assert.ok(!existsSync(stray));
});

test("file names are one safe path segment", () => {
  assert.equal(cleanName("report.pdf"), "report.pdf");
  assert.equal(cleanName(".env"), "env");
  assert.equal(cleanName("a/b\\c:d"), "a_b_c_d");
  assert.equal(cleanName(""), "file");
  const long = cleanName(`${"x".repeat(300)}.tar.gz`);
  assert.equal(long.length, 120);
  assert.ok(long.endsWith(".gz"));
});
