/**
 * Attachments waiting in the composer, one list per bot (kept across bot switches, like drafts). Each
 * starts uploading as soon as it's added, so sending only names them (see the protocol's Attachment).
 * Images are prepared first: shrunk to MAX_IMAGE_EDGE on their long side, and re-encoded when they're
 * over MAX_IMAGE_BYTES.
 */
import { type Attachment, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, MAX_IMAGE_BYTES, MAX_IMAGE_EDGE, MODEL_IMAGE_TYPES } from "@top/client";
import { useSyncExternalStore } from "react";
import { top } from "./top.ts";

export type Draft = {
  readonly key: number;
  readonly name: string;
  /** What's uploaded: the prepared file. */
  readonly file: File;
  readonly kind: "image" | "file";
  /** A local link to show an image before (and while) it uploads. */
  readonly preview?: string;
  readonly state: "preparing" | "uploading" | "ready" | "failed";
  /** Fraction uploaded, while uploading. */
  readonly progress: number;
  readonly error?: string;
  readonly uploaded?: Attachment;
};

const NONE: readonly Draft[] = [];
const lists = new Map<string, readonly Draft[]>();
const listeners = new Set<() => void>();
let nextKey = 1;

function emit() {
  for (const listener of listeners) listener();
}

function update(bot: string, key: number, change: Partial<Draft>) {
  const list = lists.get(bot);
  if (!list?.some((d) => d.key === key)) return;
  lists.set(
    bot,
    list.map((d) => (d.key === key ? { ...d, ...change } : d)),
  );
  emit();
}

const find = (bot: string, key: number) => lists.get(bot)?.find((d) => d.key === key);

export function useAttachments(bot: string): readonly Draft[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => lists.get(bot) ?? NONE,
  );
}

export const attachmentsOf = (bot: string): readonly Draft[] => lists.get(bot) ?? NONE;

export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ── what a file is ───────────────────────────────────────────────────────────

const IMAGE_EXTENSIONS: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
const TEXT_EXTENSIONS =
  /^(txt|md|markdown|csv|tsv|log|json|jsonl|ya?ml|toml|ini|cfg|conf|env|xml|html?|css|scss|less|js|mjs|cjs|jsx|ts|mts|cts|tsx|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|fish|ps1|sql|lua|r|dart|vue|svelte|graphql|proto|tex|diff|patch)$/;

/**
 * A file's type, trusting what the system says unless it says nothing useful: then its extension.
 * (Some systems call `.ts` files "video/mp2t", the video format.)
 */
function typeOf(file: File): string {
  const type = file.type.toLowerCase();
  if (type && type !== "application/octet-stream" && type !== "video/mp2t") return type;
  const ext = file.name.toLowerCase().split(".").pop() ?? "";
  return IMAGE_EXTENSIONS[ext] ?? (TEXT_EXTENSIONS.test(ext) ? "text/plain" : type || "application/octet-stream");
}

// ── preparing images ─────────────────────────────────────────────────────────

const encode = (canvas: OffscreenCanvas, type: string, quality?: number) => canvas.convertToBlob({ type, ...(quality ? { quality } : {}) });

/**
 * An image the model can take: at most MAX_IMAGE_EDGE on its long side and MAX_IMAGE_BYTES in size,
 * turned upright by its EXIF orientation. One that's fine already is left as it is, and so is a GIF
 * (shrinking would lose its animation). Undefined if it can't be read as an image.
 */
async function prepareImage(file: File, type: string): Promise<File | undefined> {
  if (type === "image/gif") return file;
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" }).catch(() => undefined);
  if (!bitmap) return undefined;
  try {
    const long = Math.max(bitmap.width, bitmap.height);
    if (long <= MAX_IMAGE_EDGE && file.size <= MAX_IMAGE_BYTES) return file;
    const draw = (scale: number) => {
      const canvas = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)));
      const context = canvas.getContext("2d")!;
      context.imageSmoothingQuality = "high";
      // JPEG has no transparency: white behind it, not black.
      if (type === "image/jpeg") {
        context.fillStyle = "#fff";
        context.fillRect(0, 0, canvas.width, canvas.height);
      }
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      return canvas;
    };
    const fit = Math.min(1, MAX_IMAGE_EDGE / long);
    // The same type first; then WebP, smaller and smaller, until it fits.
    const attempts: [number, string, number?][] = [
      [fit, type === "image/png" ? "image/png" : type, type === "image/png" ? undefined : 0.9],
      [fit, "image/webp", 0.85],
      [fit, "image/webp", 0.7],
      [fit * 0.75, "image/webp", 0.7],
      [fit * 0.5, "image/webp", 0.7],
    ];
    for (const [scale, as, quality] of attempts) {
      const blob = await encode(draw(scale), as, quality);
      if (blob.size <= MAX_IMAGE_BYTES) {
        const ext = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" }[blob.type] ?? "img";
        const name = blob.type === type ? file.name : file.name.replace(/(\.[^.]*)?$/, `.${ext}`);
        return new File([blob], name, { type: blob.type });
      }
    }
    return file; // still too big: it goes as a file (its path only)
  } finally {
    bitmap.close();
  }
}

// ── uploading ────────────────────────────────────────────────────────────────

const UPLOADS_AT_ONCE = 3;
let uploading = 0;
const waiting: (() => void)[] = [];

async function slot<T>(run: () => Promise<T>): Promise<T> {
  if (uploading >= UPLOADS_AT_ONCE) await new Promise<void>((resolve) => waiting.push(resolve));
  uploading++;
  try {
    return await run();
  } finally {
    uploading--;
    waiting.shift()?.();
  }
}

async function upload(bot: string, key: number) {
  const draft = find(bot, key);
  if (!draft) return;
  update(bot, key, { state: "uploading", progress: 0, error: undefined });
  let shown = 0;
  try {
    const uploaded = await slot(() => {
      if (!find(bot, key)) throw new DOMException("removed", "AbortError");
      return top.upload(draft.file, draft.name, {
        onProgress: (fraction) => {
          // Re-render on visible steps only.
          if (fraction - shown < 0.02 && fraction < 1) return;
          shown = fraction;
          update(bot, key, { progress: fraction });
        },
      });
    });
    update(bot, key, { state: "ready", progress: 1, uploaded });
  } catch (error) {
    if ((error as Error).name === "AbortError") return;
    update(bot, key, { state: "failed", error: (error as Error).message });
  }
}

/**
 * Add files to `bot`'s composer. Those that can't be attached are left out, and the reasons come back
 * as one sentence for the user. Slots are taken before anything is awaited, so two quick pastes can't
 * both squeeze past the limit.
 */
export function addAttachments(bot: string, files: readonly File[]): string | undefined {
  const problems: string[] = [];
  const list = [...(lists.get(bot) ?? NONE)];
  const added: Draft[] = [];
  for (const file of files) {
    if (list.length + added.length >= MAX_ATTACHMENTS) {
      problems.push(`A message can have up to ${MAX_ATTACHMENTS} attachments.`);
      break;
    }
    if (file.size === 0) {
      problems.push(`“${file.name}” is empty.`);
      continue;
    }
    const type = typeOf(file);
    const image = MODEL_IMAGE_TYPES.includes(type);
    // An image can come in larger: it's shrunk before upload.
    if (file.size > MAX_ATTACHMENT_BYTES * (image ? 2 : 1)) {
      problems.push(`“${file.name}” is over ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`);
      continue;
    }
    const typed = file.type === type ? file : new File([file], file.name, { type, lastModified: file.lastModified });
    added.push({
      key: nextKey++,
      name: file.name || (image ? "image" : "file"),
      file: typed,
      kind: image ? "image" : "file",
      ...(image ? { preview: URL.createObjectURL(file) } : {}),
      state: image ? "preparing" : "uploading",
      progress: 0,
    });
  }
  if (added.length) {
    lists.set(bot, [...list, ...added]);
    emit();
    for (const draft of added) void start(bot, draft);
  }
  return problems.length ? problems.join(" ") : undefined;
}

async function start(bot: string, draft: Draft) {
  if (draft.kind === "image") {
    const prepared = await prepareImage(draft.file, draft.file.type);
    if (!find(bot, draft.key)) return;
    if (!prepared) {
      // Not readable as an image after all: it goes as a file.
      update(bot, draft.key, { kind: "file", file: new File([draft.file], draft.name, { type: "application/octet-stream" }) });
    } else if (prepared.size > MAX_ATTACHMENT_BYTES) {
      return update(bot, draft.key, { state: "failed", error: "Too large to attach, even shrunk." });
    } else {
      update(bot, draft.key, { file: prepared, name: prepared.name });
    }
  }
  await upload(bot, draft.key);
}

export function retryAttachment(bot: string, key: number) {
  void upload(bot, key);
}

export function removeAttachment(bot: string, key: number) {
  const draft = find(bot, key);
  if (!draft) return;
  if (draft.preview) URL.revokeObjectURL(draft.preview);
  lists.set(
    bot,
    (lists.get(bot) ?? NONE).filter((d) => d.key !== key),
  );
  emit();
}

/** After a send: the composer starts empty. */
export function clearAttachments(bot: string) {
  for (const draft of lists.get(bot) ?? NONE) if (draft.preview) URL.revokeObjectURL(draft.preview);
  lists.delete(bot);
  emit();
}

/** What a send would carry, or why it can't go yet. */
export function readyAttachments(bot: string): { ready: Attachment[] } | { wait: string } {
  const list = lists.get(bot) ?? NONE;
  if (list.some((d) => d.state === "failed")) return { wait: "An attachment didn't upload: retry it or remove it." };
  if (list.some((d) => d.state !== "ready")) return { wait: "Attachments are still uploading." };
  return { ready: list.map((d) => d.uploaded!) };
}

// ── pasting a lot of text ────────────────────────────────────────────────────

/** A paste this large (in bytes) becomes a text file instead of filling the message. */
export const LARGE_PASTE_BYTES = 32 * 1024;

/** `pasted-text.txt`, or the next free `pasted-text-2.txt`, … among `bot`'s attachments. */
export function pastedTextName(bot: string): string {
  const taken = new Set((lists.get(bot) ?? NONE).map((d) => d.name));
  for (let n = 1; ; n++) {
    const name = n === 1 ? "pasted-text.txt" : `pasted-text-${n}.txt`;
    if (!taken.has(name)) return name;
  }
}
