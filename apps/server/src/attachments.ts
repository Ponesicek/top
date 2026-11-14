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
import { join, resolve } from "node:path";
import { type Attachment, AttachmentError, isModelImage, MAX_ATTACHMENT_BYTES, MODEL_IMAGE_TYPES } from "@top/protocol";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { type FileServing, sendFile } from "./sendFile.ts";
import { Store } from "./store.ts";

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

const textResponse = (request: HttpServerRequest.HttpServerRequest, status: number, message: string) =>
  HttpServerResponse.text(request.method === "HEAD" ? "" : message, {
    status,
    contentType: "text/plain; charset=utf-8",
    headers: { "cache-control": "no-store", "access-control-allow-origin": "*" },
  });

export class Attachments extends Context.Service<
  Attachments,
  {
    readonly root: string;
    /** Where an attachment's file is, on this computer. */
    readonly path: (attachment: Pick<Attachment, "id" | "name">) => string;
    /** The bot's uploads by id, in order; fails naming one that doesn't exist (or is another bot's). */
    readonly lookup: (bot: number, ids: readonly string[]) => Effect.Effect<Attachment[], AttachmentError>;
    /** An image's bytes as base64, for the model; undefined if its file is gone. */
    readonly imageData: (attachment: Attachment) => Effect.Effect<string | undefined>;
    /** Delete a bot's attachments, before its rows go (store.purgeBot). */
    readonly removeBot: (bot: number) => Effect.Effect<void>;
    /** Delete unclaimed uploads past their day, and folders the store doesn't know. */
    readonly sweep: Effect.Effect<void>;
    /** An HTTP request under `<attachmentsPath>/`; `rest` is what follows: `upload` or an id. */
    readonly handle: (request: HttpServerRequest.HttpServerRequest, rest: string) => Effect.Effect<HttpServerResponse.HttpServerResponse, never, FileServing>;
  }
>()("top/Attachments") {}

/** Attachments kept under `<dataDir>/attachments`, swept every hour while the layer lives. */
export const layer = (dataDir: string): Layer.Layer<Attachments, never, Store | FileSystem.FileSystem> =>
  Layer.effect(
    Attachments,
    Effect.gen(function* () {
      const store = yield* Store;
      const fs = yield* FileSystem.FileSystem;
      const root = resolve(dataDir, "attachments");
      const images = new Map<string, string>();
      let imageBytes = 0;
      const path = (attachment: Pick<Attachment, "id" | "name">) => join(root, attachment.id, cleanName(attachment.name));

      const remove = (id: string) =>
        Effect.gen(function* () {
          const data = images.get(id);
          if (data !== undefined) {
            images.delete(id);
            imageBytes -= data.length;
          }
          yield* Effect.ignore(fs.remove(join(root, id), { recursive: true, force: true }));
        });

      const sweep = Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        for (const row of yield* store.unclaimedAttachments(now - UNCLAIMED_MS)) {
          yield* remove(row.id);
          yield* store.deleteAttachment(row.id);
        }
        const folders = yield* fs.readDirectory(root).pipe(Effect.orElseSucceed((): string[] => []));
        for (const id of folders) {
          if (!ID.test(id) || (yield* store.attachment(id))) continue;
          // Not one being uploaded right now.
          const info = yield* Effect.option(fs.stat(join(root, id)));
          const mtime = Option.flatMap(info, (i) => i.mtime);
          if (Option.isSome(mtime) && now - mtime.value.getTime() > SWEEP_MS) yield* remove(id);
        }
      }).pipe(Effect.catchCause((cause) => Effect.logError("sweeping attachments", cause)));

      /** Take one upload: the raw bytes, exactly `Content-Length` of them, into its own folder. */
      const receive = (request: HttpServerRequest.HttpServerRequest, rawName: string) =>
        Effect.gen(function* () {
          const length = Number(request.headers["content-length"]);
          if (!Number.isInteger(length) || length < 0) return textResponse(request, 411, "Send the file's length (Content-Length).");
          if (length === 0) return textResponse(request, 400, "The file is empty.");
          if (length > MAX_ATTACHMENT_BYTES) return textResponse(request, 413, `Files can be up to ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`);
          const name = cleanName(rawName);
          const id = randomBytes(12).toString("base64url");
          const folder = join(root, id);
          const part = join(folder, ".part");
          let head = Buffer.alloc(0);
          let received = 0;
          const written = yield* Effect.scoped(
            Effect.gen(function* () {
              yield* fs.makeDirectory(folder, { recursive: true });
              const file = yield* fs.open(part, { flag: "w" });
              yield* request.stream.pipe(
                Stream.runForEach((chunk) =>
                  Effect.gen(function* () {
                    received += chunk.length;
                    if (received > length) return yield* Effect.fail("too long" as const);
                    if (head.length < 16) head = Buffer.concat([head, Buffer.from(chunk)]);
                    yield* file.writeAll(chunk);
                  }),
                ),
              );
              yield* file.sync;
              return received === length;
            }),
          ).pipe(Effect.orElseSucceed(() => false));
          if (!written) {
            yield* Effect.ignore(fs.remove(folder, { recursive: true, force: true }));
            return textResponse(request, 400, `Expected ${length} bytes, got ${received}.`);
          }
          const attachment: Attachment = { id, name, mimeType: decideType(String(request.headers["content-type"] ?? ""), head), size: length };
          yield* Effect.orDie(fs.rename(part, path(attachment)));
          yield* store.addAttachment(attachment);
          return HttpServerResponse.jsonUnsafe(attachment, { headers: { "cache-control": "no-store", "access-control-allow-origin": "*" } });
        });

      const handle = (request: HttpServerRequest.HttpServerRequest, rest: string) =>
        Effect.gen(function* () {
          // The app uploads from `file://` (and the dev UI from :5199): the secret in the path is what guards this.
          if (request.method === "OPTIONS")
            return HttpServerResponse.empty({
              status: 204,
              headers: {
                "access-control-allow-origin": "*",
                "access-control-allow-methods": "GET, HEAD, POST",
                "access-control-allow-headers": "Content-Type, Range",
                "access-control-max-age": "86400",
              },
            });
          if (rest === "upload") {
            if (request.method !== "POST") return textResponse(request, 405, "Only POST");
            return yield* receive(request, new URL(request.url, "http://top").searchParams.get("name") ?? "");
          }
          if (request.method !== "GET" && request.method !== "HEAD") return textResponse(request, 405, "Only GET and HEAD");
          const row = ID.test(rest) ? yield* store.attachment(rest) : undefined;
          if (!row) return textResponse(request, 404, "Not found");
          const as = servedAs(row);
          return yield* sendFile(request, path(row), {
            "Content-Type": as.type,
            "Content-Disposition": `${as.inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(cleanName(row.name))}`,
            // An attachment never changes.
            "Cache-Control": "private, max-age=31536000, immutable",
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer",
            "Access-Control-Allow-Origin": "*",
            ...(as.sandbox ? { "Content-Security-Policy": "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox" } : {}),
          }).pipe(Effect.catchTag("NotFound", () => Effect.succeed(textResponse(request, 404, "Not found"))));
        });

      yield* Effect.forkScoped(Effect.repeat(sweep, Schedule.spaced(Duration.millis(SWEEP_MS))));

      return Attachments.of({
        root,
        path,
        lookup: Effect.fn("Attachments.lookup")((bot: number, ids: readonly string[]) =>
          Effect.forEach(ids, (id) =>
            Effect.gen(function* () {
              const row = ID.test(id) ? yield* store.attachment(id) : undefined;
              if (!row || (row.bot !== null && row.bot !== bot))
                return yield* new AttachmentError({ message: "An attachment is gone (uploads are kept a day): attach it again." });
              return { id: row.id, name: row.name, mimeType: row.mimeType, size: row.size };
            }),
          ),
        ),
        imageData: Effect.fn("Attachments.imageData")(function* (attachment) {
          const cached = images.get(attachment.id);
          if (cached !== undefined) {
            // Most recently used goes last.
            images.delete(attachment.id);
            images.set(attachment.id, cached);
            return cached;
          }
          const bytes = yield* Effect.option(fs.readFile(path(attachment)));
          if (Option.isNone(bytes)) return undefined;
          const data = Buffer.from(bytes.value).toString("base64");
          images.set(attachment.id, data);
          imageBytes += data.length;
          for (const [id, old] of images) {
            if (imageBytes <= IMAGE_CACHE_BYTES || id === attachment.id) break;
            images.delete(id);
            imageBytes -= old.length;
          }
          return data;
        }),
        removeBot: Effect.fn("Attachments.removeBot")(function* (bot) {
          for (const row of yield* store.botAttachments(bot)) yield* remove(row.id);
        }),
        sweep: Effect.withSpan(sweep, "Attachments.sweep"),
        handle: (request, rest) => Effect.withSpan(handle(request, rest), "Attachments.handle"),
      });
    }),
  );

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
export const withImageData = <M>(messages: M[], attachments: Attachments["Service"]): Effect.Effect<M[]> =>
  Effect.forEach(messages, (message) => {
    const m = message as ContextMessage;
    if (m.role !== "user" || !Array.isArray(m.content) || !m.content.some((p: Part) => p.type === "image" && p.attachment && !p.data))
      return Effect.succeed(message);
    return Effect.map(
      Effect.forEach(m.content as Part[], (part) => {
        if (part.type !== "image" || !part.attachment || part.data) return Effect.succeed(part);
        const attachment = m.attachments?.find((a) => a.id === part.attachment);
        return Effect.map(
          attachment ? attachments.imageData(attachment) : Effect.undefined,
          (data): Part => (data ? { ...part, data } : { type: "text", text: `[The image "${attachment?.name ?? part.attachment}" is no longer available.]` }),
        );
      }),
      (content) => ({ ...message, content }) as M,
    );
  });
