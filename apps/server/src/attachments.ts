/**
 * Attachments: files the user sends with a message (see the protocol's Attachment). Each upload lands
 * at its final path, `<data>/attachments/<id>/<name>`, and never moves: a message claiming it only
 * marks it as its bot's (store.ts), so nothing can be half moved by a crash. The bot is told that path,
 * and its tools can open the file; images go to the model as images too (`imageData`).
 *
 * Uploads no message claims are deleted after a day, a bot's go with the bot, and a folder the store
 * doesn't know (a crash mid-upload) goes on the next sweep.
 */
import { randomBytes } from "node:crypto";
import { createWriteStream, type Stats } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { type Attachment, isModelImage, MAX_ATTACHMENT_BYTES, MODEL_IMAGE_TYPES } from "@top/protocol";
import { sendFile } from "./sendFile.ts";
import type { Store } from "./store.ts";

const UNCLAIMED_MS = 24 * 60 * 60_000;
const SWEEP_MS = 60 * 60_000;
/** Images kept in memory as base64 for the next model requests (every request sends the whole context). */
const IMAGE_CACHE_BYTES = 64 * 1024 * 1024;
const ID = /^[A-Za-z0-9_-]{16}$/;

/** A file name that is one safe path segment, keeping its extension when it has to be shortened. */
export function cleanName(name: string): string {
  let clean = [...name]
    // Path separators and control characters.
    .map((c) => (/[\\/:]/.test(c) || c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f ? "_" : c))
    .join("")
    .trim()
    .replace(/^\.+/, "");
  if (clean.length > 120) {
    const dot = clean.lastIndexOf(".");
    const ext = dot > 0 && clean.length - dot <= 12 ? clean.slice(dot) : "";
    clean = clean.slice(0, 120 - ext.length) + ext;
  }
  return clean || "file";
}

/** The type the first bytes say, among the images models take, if any. */
function sniffImage(head: Buffer): string | undefined {
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (head.length >= 6 && /^GIF8[79]a$/.test(head.subarray(0, 6).toString("latin1"))) return "image/gif";
  if (head.length >= 12 && head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return undefined;
}

/**
 * What the daemon records a file as. An image type is only believed when the bytes are that image:
 * a model given a broken image refuses the request, and every later one that still carries it.
 */
function decideType(declared: string, head: Buffer): string {
  const type = declared.split(";")[0]!.trim().toLowerCase();
  const sniffed = sniffImage(head);
  if (MODEL_IMAGE_TYPES.includes(type)) return sniffed ?? "application/octet-stream";
  if (sniffed && (!type || type === "application/octet-stream")) return sniffed;
  return /^[a-z0-9][\w.+-]*\/[\w.+-]+$/.test(type) ? type : "application/octet-stream";
}

/** How an attachment is served: shown in place when that's safe, downloaded otherwise. */
function servedAs(attachment: Attachment): { type: string; inline: boolean; sandbox: boolean } {
  const type = attachment.mimeType;
  if (MODEL_IMAGE_TYPES.includes(type) || /^(audio|video)\//.test(type)) return { type, inline: true, sandbox: true };
  if (type === "application/pdf") return { type, inline: true, sandbox: false }; // the PDF viewer won't run sandboxed
  // Text of any kind (code, Markdown, JSON, HTML) shows as plain text: never run, never styled.
  if (/^text\//.test(type) || /[/+](json|xml|yaml|toml|javascript|typescript)$/.test(type))
    return { type: "text/plain; charset=utf-8", inline: true, sandbox: true };
  return { type: "application/octet-stream", inline: false, sandbox: true };
}

export class Attachments {
  readonly root: string;
  readonly #store: Store;
  readonly #images = new Map<string, string>();
  #imageBytes = 0;
  readonly #sweeper: ReturnType<typeof setInterval>;

  constructor(dataDir: string, store: Store) {
    this.root = resolve(dataDir, "attachments");
    this.#store = store;
    void this.sweep();
    this.#sweeper = setInterval(() => void this.sweep(), SWEEP_MS);
    this.#sweeper.unref();
  }

  close() {
    clearInterval(this.#sweeper);
  }

  /** Where an attachment's file is, on this computer. */
  path(attachment: Pick<Attachment, "id" | "name">): string {
    return join(this.root, attachment.id, cleanName(attachment.name));
  }

  /** The bot's uploads by id, in order, or an error naming one that doesn't exist (or is another bot's). */
  lookup(bot: number, ids: readonly string[]): Attachment[] {
    return ids.map((id) => {
      const row = ID.test(id) ? this.#store.attachment(id) : undefined;
      if (!row || (row.bot !== null && row.bot !== bot)) throw new Error("An attachment is gone (uploads are kept a day): attach it again.");
      return { id: row.id, name: row.name, mimeType: row.mimeType, size: row.size };
    });
  }

  /** An image's bytes as base64, for the model; undefined if its file is gone. */
  async imageData(attachment: Attachment): Promise<string | undefined> {
    const cached = this.#images.get(attachment.id);
    if (cached !== undefined) {
      // Most recently used goes last.
      this.#images.delete(attachment.id);
      this.#images.set(attachment.id, cached);
      return cached;
    }
    const data = await readFile(this.path(attachment))
      .then((bytes) => bytes.toString("base64"))
      .catch(() => undefined);
    if (data === undefined) return undefined;
    this.#images.set(attachment.id, data);
    this.#imageBytes += data.length;
    for (const [id, old] of this.#images) {
      if (this.#imageBytes <= IMAGE_CACHE_BYTES || id === attachment.id) break;
      this.#images.delete(id);
      this.#imageBytes -= old.length;
    }
    return data;
  }

  /** Delete a bot's attachments, before its rows go (store.purgeBot). */
  async removeBot(bot: number) {
    await Promise.all(this.#store.botAttachments(bot).map((a) => this.#remove(a.id)));
  }

  /** Delete unclaimed uploads past their day, and folders the store doesn't know. */
  async sweep() {
    for (const row of this.#store.unclaimedAttachments(Date.now() - UNCLAIMED_MS)) {
      await this.#remove(row.id);
      this.#store.deleteAttachment(row.id);
    }
    const folders = await readdir(this.root).catch(() => [] as string[]);
    for (const id of folders) {
      if (!ID.test(id) || this.#store.attachment(id)) continue;
      // Not one being uploaded right now.
      const info = await stat(join(this.root, id)).catch(() => undefined);
      if (info && Date.now() - info.mtimeMs > SWEEP_MS) await this.#remove(id);
    }
  }

  async #remove(id: string) {
    const data = this.#images.get(id);
    if (data !== undefined) {
      this.#images.delete(id);
      this.#imageBytes -= data.length;
    }
    await rm(join(this.root, id), { recursive: true, force: true });
  }

  // ── HTTP ─────────────────────────────────────────────────────────────────────

  /** `rest`: the path after `<attachmentsPath>/`, i.e. `upload` or an id. */
  async handle(request: IncomingMessage, response: ServerResponse, rest: string, query: URLSearchParams) {
    const fail = (status: number, message: string) => {
      response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      response.end(request.method === "HEAD" ? undefined : message);
    };
    // The app uploads from `file://` (and the dev UI from :5199): the secret in the path is what guards this.
    response.setHeader("Access-Control-Allow-Origin", "*");
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "Access-Control-Allow-Methods": "GET, HEAD, POST",
        "Access-Control-Allow-Headers": "Content-Type, Range",
        "Access-Control-Max-Age": "86400",
      });
      return response.end();
    }
    if (rest === "upload") {
      if (request.method !== "POST") return fail(405, "Only POST");
      return this.#receive(request, response, query.get("name") ?? "", fail);
    }
    if (request.method !== "GET" && request.method !== "HEAD") return fail(405, "Only GET and HEAD");
    const row = ID.test(rest) ? this.#store.attachment(rest) : undefined;
    if (!row) return fail(404, "Not found");
    const path = this.path(row);
    const info: Stats | undefined = await stat(path).catch(() => undefined);
    if (!info?.isFile()) return fail(404, "Not found");
    const as = servedAs(row);
    sendFile(request, response, path, info, {
      "Content-Type": as.type,
      "Content-Disposition": `${as.inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(cleanName(row.name))}`,
      // An attachment never changes.
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      ...(as.sandbox ? { "Content-Security-Policy": "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox" } : {}),
    });
  }

  /** Take one upload: the raw bytes, exactly `Content-Length` of them, into its own folder. */
  async #receive(request: IncomingMessage, response: ServerResponse, rawName: string, fail: (status: number, message: string) => void) {
    const length = Number(request.headers["content-length"]);
    if (!Number.isInteger(length) || length < 0) return fail(411, "Send the file's length (Content-Length).");
    if (length === 0) return fail(400, "The file is empty.");
    if (length > MAX_ATTACHMENT_BYTES) return fail(413, `Files can be up to ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`);
    const name = cleanName(rawName);
    const id = randomBytes(12).toString("base64url");
    const folder = join(this.root, id);
    await mkdir(folder, { recursive: true });
    const part = join(folder, ".part");
    const head: Buffer[] = [];
    let headBytes = 0;
    let received = 0;
    const ok = await new Promise<boolean>((done) => {
      const out = createWriteStream(part);
      request.on("data", (chunk: Buffer) => {
        received += chunk.length;
        if (headBytes < 16) {
          head.push(chunk);
          headBytes += chunk.length;
        }
        if (received > length) request.destroy();
      });
      request.on("aborted", () => done(false));
      request.on("error", () => done(false));
      out.on("error", () => done(false));
      out.on("finish", () => done(received === length));
      request.pipe(out);
    });
    if (!ok) {
      await rm(folder, { recursive: true, force: true });
      if (!response.destroyed) fail(400, `Expected ${length} bytes, got ${received}.`);
      return;
    }
    const attachment: Attachment = { id, name, mimeType: decideType(String(request.headers["content-type"] ?? ""), Buffer.concat(head)), size: length };
    await rename(part, this.path(attachment));
    this.#store.addAttachment(attachment);
    response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    response.end(JSON.stringify(attachment));
  }
}

// ── what the model gets ──────────────────────────────────────────────────────

const sizeLabel = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

type Part = { type: string; text?: string; data?: string; mimeType?: string; attachment?: string; attachmentNote?: true };

/**
 * A user message with attachments: the text, one line per attachment saying where it is saved (never
 * cut: the bot must know each one exists), then the images it can see. An image part holds only its
 * attachment's id; `withImageData` puts the bytes in for each model request, so the transcript stays
 * small. The note is marked, so clients are shown only what the user wrote (wire.ts).
 */
export function userContent(text: string, attachments: readonly Attachment[], pathOf: (attachment: Attachment) => string): Part[] {
  const parts: Part[] = [];
  // No empty text block: some providers refuse them.
  if (text.trim()) parts.push({ type: "text", text });
  const lines = attachments.map(
    (a) => `[Attached ${isModelImage(a) ? "image" : "file"} "${a.name}" (${a.mimeType}, ${sizeLabel(a.size)}) is saved at: ${pathOf(a)}]`,
  );
  parts.push({ type: "text", text: lines.join("\n"), attachmentNote: true });
  for (const a of attachments) if (isModelImage(a)) parts.push({ type: "image", mimeType: a.mimeType, data: "", attachment: a.id });
  return parts;
}

type ContextMessage = { role?: string; content?: unknown; attachments?: readonly Attachment[] };

/** The context for one model request, with each image part's bytes read in (or a note, if its file is gone). */
export async function withImageData<M>(messages: M[], attachments: Attachments): Promise<M[]> {
  return Promise.all(
    messages.map(async (message) => {
      const m = message as ContextMessage;
      if (m.role !== "user" || !Array.isArray(m.content) || !m.content.some((p: Part) => p.type === "image" && p.attachment && !p.data)) return message;
      const content = await Promise.all(
        (m.content as Part[]).map(async (part) => {
          if (part.type !== "image" || !part.attachment || part.data) return part;
          const attachment = m.attachments?.find((a) => a.id === part.attachment);
          const data = attachment && (await attachments.imageData(attachment));
          return data ? { ...part, data } : { type: "text", text: `[The image "${attachment?.name ?? part.attachment}" is no longer available.]` };
        }),
      );
      return { ...message, content } as M;
    }),
  );
}
