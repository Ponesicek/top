import { useAtomValue } from "@effect/atom-react";
import { type Attachment, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, MAX_IMAGE_BYTES, MAX_IMAGE_EDGE, MODEL_IMAGE_TYPES } from "@top/client";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Atom from "effect/reactivity/Atom";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { registry, top } from "./top.ts";

export type Draft = {
  readonly key: number;
  readonly name: string;
  readonly file: File;
  readonly kind: "image" | "file";
  readonly preview?: string;
  readonly state: "preparing" | "uploading" | "ready" | "failed";
  readonly progress: number;
  readonly error?: string | undefined;
  readonly uploaded?: Attachment;
};

const NONE: readonly Draft[] = [];
const listsAtom = Atom.make<ReadonlyMap<string, readonly Draft[]>>(new Map()).pipe(Atom.keepAlive);
let nextKey = 1;

const listOf = (bot: string) => registry.get(listsAtom).get(bot) ?? NONE;
function setList(bot: string, list: readonly Draft[] | undefined) {
  const lists = new Map(registry.get(listsAtom));
  if (list) lists.set(bot, list);
  else lists.delete(bot);
  registry.set(listsAtom, lists);
}

function update(bot: string, key: number, change: Partial<Draft>) {
  const list = listOf(bot);
  if (!list.some((d) => d.key === key)) return;
  setList(
    bot,
    list.map((d) => (d.key === key ? { ...d, ...change } : d)),
  );
}

const find = (bot: string, key: number) => listOf(bot).find((d) => d.key === key);

export function useAttachments(bot: string): readonly Draft[] {
  return useAtomValue(listsAtom, (lists) => lists.get(bot) ?? NONE);
}

export const attachmentsOf = (bot: string): readonly Draft[] => listOf(bot);

export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const IMAGE_EXTENSIONS: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
const TEXT_EXTENSIONS =
  /^(txt|md|markdown|csv|tsv|log|json|jsonl|ya?ml|toml|ini|cfg|conf|env|xml|html?|css|scss|less|js|mjs|cjs|jsx|ts|mts|cts|tsx|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|fish|ps1|sql|lua|r|dart|vue|svelte|graphql|proto|tex|diff|patch)$/;

function typeOf(file: File): string {
  const type = file.type.toLowerCase();
  if (type && type !== "application/octet-stream" && type !== "video/mp2t") return type;
  const ext = file.name.toLowerCase().split(".").pop() ?? "";
  return IMAGE_EXTENSIONS[ext] ?? (TEXT_EXTENSIONS.test(ext) ? "text/plain" : type || "application/octet-stream");
}

const encode = (canvas: OffscreenCanvas, type: string, quality?: number) => canvas.convertToBlob({ type, ...(quality ? { quality } : {}) });

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
      if (type === "image/jpeg") {
        context.fillStyle = "#fff";
        context.fillRect(0, 0, canvas.width, canvas.height);
      }
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      return canvas;
    };
    const fit = Math.min(1, MAX_IMAGE_EDGE / long);
    const attempts: [number, string, (number | undefined)?][] = [
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
    return file;
  } finally {
    bitmap.close();
  }
}

const UPLOADS_AT_ONCE = 3;
const scope = Scope.makeUnsafe();
const slots = Semaphore.makeUnsafe(UPLOADS_AT_ONCE);
const work = Effect.runSync(FiberMap.make<number>().pipe(Scope.provide(scope)));

const upload = (bot: string, key: number) =>
  Effect.gen(function* () {
    const draft = find(bot, key);
    if (!draft) return;
    update(bot, key, { state: "uploading", progress: 0, error: undefined });
    let shown = 0;
    const uploaded = yield* slots.withPermits(1)(
      Effect.tryPromise((signal) =>
        top.upload(draft.file, draft.name, {
          signal,
          onProgress: (fraction) => {
            if (fraction - shown < 0.02 && fraction < 1) return;
            shown = fraction;
            update(bot, key, { progress: fraction });
          },
        }),
      ),
    );
    update(bot, key, { state: "ready", progress: 1, uploaded });
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.sync(() => {
        const error = Cause.squash(cause);
        const reason = error instanceof Error && error.cause instanceof Error ? error.cause : error;
        update(bot, key, { state: "failed", error: reason instanceof Error ? reason.message : String(reason) });
      }),
    ),
  );

const run = (key: number, effect: Effect.Effect<void>) => Effect.runFork(FiberMap.run(work, key, effect));

export function addAttachments(bot: string, files: readonly File[]): string | undefined {
  const problems: string[] = [];
  const list = [...listOf(bot)];
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
    setList(bot, [...list, ...added]);
    for (const draft of added) run(draft.key, start(bot, draft));
  }
  return problems.length ? problems.join(" ") : undefined;
}

const start = (bot: string, draft: Draft) =>
  Effect.gen(function* () {
    if (draft.kind === "image") {
      const prepared = yield* Effect.promise(() => prepareImage(draft.file, draft.file.type));
      if (!find(bot, draft.key)) return;
      if (!prepared) {
        update(bot, draft.key, { kind: "file", file: new File([draft.file], draft.name, { type: "application/octet-stream" }) });
      } else if (prepared.size > MAX_ATTACHMENT_BYTES) {
        return update(bot, draft.key, { state: "failed", error: "Too large to attach, even shrunk." });
      } else {
        update(bot, draft.key, { file: prepared, name: prepared.name });
      }
    }
    yield* upload(bot, draft.key);
  });

export function retryAttachment(bot: string, key: number) {
  run(key, upload(bot, key));
}

export function removeAttachment(bot: string, key: number) {
  const draft = find(bot, key);
  if (!draft) return;
  if (draft.preview) URL.revokeObjectURL(draft.preview);
  Effect.runFork(FiberMap.remove(work, key));
  setList(
    bot,
    listOf(bot).filter((d) => d.key !== key),
  );
}

export function clearAttachments(bot: string) {
  for (const draft of listOf(bot)) if (draft.preview) URL.revokeObjectURL(draft.preview);
  setList(bot, undefined);
}

export function readyAttachments(bot: string): { ready: Attachment[] } | { wait: string } {
  const list = listOf(bot);
  if (list.some((d) => d.state === "failed")) return { wait: "An attachment didn't upload: retry it or remove it." };
  if (list.some((d) => d.state !== "ready")) return { wait: "Attachments are still uploading." };
  return { ready: list.map((d) => d.uploaded!) };
}

export const LARGE_PASTE_BYTES = 32 * 1024;

export function pastedTextName(bot: string): string {
  const taken = new Set(listOf(bot).map((d) => d.name));
  for (let n = 1; ; n++) {
    const name = n === 1 ? "pasted-text.txt" : `pasted-text-${n}.txt`;
    if (!taken.has(name)) return name;
  }
}
