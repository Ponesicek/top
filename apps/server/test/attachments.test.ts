/**
 * Attachments: uploads over HTTP, what the daemon decides each file is, a message claiming them, what
 * the bot gets (its text, a path per file, images as images) and what clients see, and cleanup.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { type Attachment, MAX_ATTACHMENT_BYTES } from "@top/protocol";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { afterAll as after, test } from "vitest";
import * as Attachments from "../src/attachments.ts";
import { cleanName, withImageData } from "../src/attachments.ts";
import * as Store from "../src/store.ts";
import { toWire } from "../src/wire.ts";
import { harness, idle, until } from "./harness.ts";

const cleanup: (() => Promise<void> | void)[] = [];
after(async () => {
  for (const fn of cleanup.reverse()) await fn();
});

/** A 1×1 PNG. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

async function setup(names = ["Atlas"]) {
  const h = await harness({ bots: names, attachments: true, gatherMs: 50, tps: 5_000, serve: {} });
  const attachments = h.attachments!;
  const base = `http://127.0.0.1:${h.port}/attachments/${h.store.filesSecret}`;
  const upload = async (name: string, type: string, body: Buffer) => {
    const response = await fetch(`${base}/upload?name=${encodeURIComponent(name)}`, { method: "POST", headers: { "Content-Type": type }, body });
    return { status: response.status, body: response.ok ? ((await response.json()) as Attachment) : await response.text() };
  };
  return { ...h, attachments, base, upload };
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
  const h = await setup();
  const { daemon, upload, attachments, bot } = h;
  await h.run(daemon.start);
  const image = (await upload("shot.png", "image/png", PNG)).body as Attachment;
  const notes = (await upload("notes.txt", "text/plain", Buffer.from("hello"))).body as Attachment;
  await h.run(daemon.submit(bot, "r1", "What is in these?", "followUp", null, [image.id, notes.id]));
  // Queued: the inbox keeps them, so they survive a restart.
  const placed = await until("the message to reach the bot", async () => (await h.entries()).find((e) => e.kind === "user"));
  await until("the answer", async () => (await h.entries()).some((e) => e.kind === "assistant"));

  // Clients see the text and the attachments, not the note for the bot.
  const wire = toWire(placed);
  assert.equal(wire?.kind, "user");
  assert.equal(wire?.kind === "user" && wire.text, "What is in these?");
  assert.deepEqual(wire?.kind === "user" && wire.attachments, [image, notes]);

  // The stored message holds the image by id only; each request reads its bytes in.
  const message = (await h.run(h.store.context(bot))).find((m) => m.role === "user");
  assert(message?.role === "user" && typeof message.content !== "string");
  const [said, note, picture] = message.content;
  assert.deepEqual(said, { type: "text", text: "What is in these?" });
  assert(note?.type === "text" && note.attachmentNote);
  assert.match(note.text, /\[Attached image "shot\.png" \(image\/png, \d+ B\) is saved at: .*shot\.png\]/);
  assert.match(note.text, /\[Attached file "notes\.txt" \(text\/plain, 5 B\) is saved at: .*notes\.txt\]/);
  assert.deepEqual(picture, { type: "image", mimeType: "image/png", data: "", attachment: image.id });
  const [hydrated] = await h.run(withImageData([message], attachments));
  assert(hydrated?.role === "user" && typeof hydrated.content !== "string");
  assert.deepEqual(hydrated.content[2], { type: "image", mimeType: "image/png", data: PNG.toString("base64"), attachment: image.id });

  // An image whose file is gone becomes a note rather than a broken image (to an attachments service
  // that hasn't cached it).
  rmSync(join(attachments.root, image.id), { recursive: true });
  const runtime = ManagedRuntime.make(
    Attachments.layer(join(attachments.root, "..")).pipe(Layer.provide(Layer.mergeAll(Layer.succeed(Store.Store, h.store), NodeServices.layer))),
  );
  cleanup.push(() => runtime.dispose());
  const fresh = await runtime.runPromise(Effect.service(Attachments.Attachments));
  const [gone] = await runtime.runPromise(withImageData([message], fresh));
  assert(gone?.role === "user" && typeof gone.content !== "string");
  assert.deepEqual(gone.content[2], { type: "text", text: '[The image "shot.png" is no longer available.]' });
});

test("a message can't use another bot's attachments, ones that don't exist, or carry nothing at all", async () => {
  const h = await setup(["Atlas", "Moss"]);
  const { daemon, upload, bot, bots } = h;
  const other = bots[1]!;
  await h.run(daemon.start);
  const file = (await upload("a.txt", "text/plain", Buffer.from("a"))).body as Attachment;
  await h.run(daemon.submit(bot, "r1", "", "followUp", null, [file.id]));
  await assert.rejects(h.run(daemon.submit(other, "r2", "mine?", "followUp", null, [file.id])), { name: "AttachmentError", message: /attach it again/ });
  await assert.rejects(h.run(daemon.submit(bot, "r3", "hi", "followUp", null, ["AAAAAAAAAAAAAAAA"])), { name: "AttachmentError" });
  await assert.rejects(h.run(daemon.submit(bot, "r4", "  ", "followUp", null, [])), { name: "AttachmentError", message: /empty/ });
  await until("the bot to finish", () => idle(h));
});

test("a deleted bot's attachments go with it, and folders the store doesn't know are swept", async () => {
  const h = await setup();
  const { daemon, upload, attachments, bot } = h;
  const file = (await upload("a.txt", "text/plain", Buffer.from("a"))).body as Attachment;
  await h.run(daemon.submit(bot, "r1", "keep this", "followUp", null, [file.id]));
  assert.ok(existsSync(attachments.path(file)));
  await h.run(daemon.deleteBot(bot));
  await until("the file to go", () => !existsSync(attachments.path(file)));

  const stray = join(attachments.root, "strayFolder00000");
  mkdirSync(stray, { recursive: true });
  const old = new Date(Date.now() - 2 * 60 * 60_000);
  utimesSync(stray, old, old);
  await h.run(attachments.sweep);
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
