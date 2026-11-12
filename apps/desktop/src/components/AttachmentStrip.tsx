/**
 * The attachments waiting in the composer: images as thumbnails (click to see them full size), other
 * files as cards with their name and size. Each shows its upload's progress, offers Retry when it
 * failed, and × to remove it.
 */
import { RotateCcw, X } from "lucide-react";
import { memo, useState } from "react";
import { type Draft, removeAttachment, retryAttachment, sizeLabel } from "../attachments.ts";
import { cn } from "../lib/utils.ts";
import { FileIcon } from "./files/FileIcon.tsx";
import { Lightbox } from "./Lightbox.tsx";
import { Tooltip } from "./ui/tooltip.tsx";

function Progress({ draft }: { draft: Draft }) {
  if (draft.state !== "uploading" && draft.state !== "preparing") return null;
  return (
    <div className="absolute inset-x-0 bottom-0 h-1 bg-black/25" aria-hidden>
      <div
        className={cn("h-full bg-primary transition-[width] duration-150", draft.state === "preparing" && "w-1/4 animate-pulse")}
        style={draft.state === "uploading" ? { width: `${Math.max(4, draft.progress * 100)}%` } : undefined}
      />
    </div>
  );
}

function Remove({ bot, draft }: { bot: string; draft: Draft }) {
  return (
    <button
      type="button"
      aria-label={`Remove ${draft.name}`}
      title="Remove"
      className="absolute top-1 right-1 grid size-5 place-items-center rounded-full bg-black/60 text-white opacity-0 transition-opacity duration-90 group-hover/tile:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
      onClick={() => removeAttachment(bot, draft.key)}
    >
      <X size={12} strokeWidth={2.6} />
    </button>
  );
}

function status(draft: Draft): string {
  if (draft.state === "failed") return `Couldn't upload: ${draft.error ?? "unknown error"}`;
  if (draft.state === "preparing") return "Preparing…";
  if (draft.state === "uploading") return `Uploading… ${Math.round(draft.progress * 100)}%`;
  return sizeLabel(draft.file.size);
}

const ImageTile = memo(function ImageTile({ bot, draft, onOpen }: { bot: string; draft: Draft; onOpen: () => void }) {
  return (
    <div className="group/tile relative size-14 flex-none overflow-hidden rounded-lg bg-secondary">
      <button type="button" className="size-full cursor-zoom-in" title={`${draft.name} · ${status(draft)}`} aria-label={`Show ${draft.name}`} onClick={onOpen}>
        <img src={draft.preview} alt="" className="size-full object-cover" draggable={false} />
      </button>
      {draft.state === "failed" && (
        <Tooltip content={status(draft)}>
          <button
            type="button"
            aria-label={`Retry uploading ${draft.name}`}
            className="absolute inset-0 grid place-items-center bg-black/55 text-white"
            onClick={() => retryAttachment(bot, draft.key)}
          >
            <RotateCcw size={16} strokeWidth={2.4} />
          </button>
        </Tooltip>
      )}
      <Progress draft={draft} />
      <Remove bot={bot} draft={draft} />
    </div>
  );
});

const FileTile = memo(function FileTile({ bot, draft }: { bot: string; draft: Draft }) {
  const failed = draft.state === "failed";
  return (
    <div
      className="group/tile relative flex h-14 max-w-60 min-w-0 items-center gap-2.5 overflow-hidden rounded-lg bg-secondary pr-7 pl-2.5"
      title={`${draft.name} · ${status(draft)}`}
    >
      <FileIcon path={draft.name} size={20} className="flex-none" />
      <div className="min-w-0 leading-tight">
        <div className="truncate text-small text-foreground">{draft.name}</div>
        <div className={cn("mt-0.5 truncate text-micro", failed ? "text-destructive-foreground" : "text-muted-foreground tabular-nums")}>
          {failed ? (
            <>
              Failed ·{" "}
              <button type="button" className="font-label underline-offset-2 hover:underline" onClick={() => retryAttachment(bot, draft.key)}>
                Retry
              </button>
            </>
          ) : draft.state === "ready" ? (
            sizeLabel(draft.file.size)
          ) : (
            status(draft)
          )}
        </div>
      </div>
      <Progress draft={draft} />
      <Remove bot={bot} draft={draft} />
    </div>
  );
});

export function AttachmentStrip({ bot, drafts }: { bot: string; drafts: readonly Draft[] }) {
  const [open, setOpen] = useState<number | undefined>();
  const images = drafts.filter((d) => d.kind === "image" && d.preview);
  return (
    <fieldset className="m-0 flex min-w-0 flex-wrap gap-1.5 border-0 p-0 pt-0.5 pb-1.5 pl-8 narrow:pl-0" aria-label="Attachments">
      {drafts.map((draft) =>
        draft.kind === "image" && draft.preview ? (
          <ImageTile key={draft.key} bot={bot} draft={draft} onOpen={() => setOpen(images.indexOf(draft))} />
        ) : (
          <FileTile key={draft.key} bot={bot} draft={draft} />
        ),
      )}
      {open !== undefined && <Lightbox images={images.map((d) => ({ src: d.preview!, name: d.name }))} start={open} onClose={() => setOpen(undefined)} />}
    </fieldset>
  );
}
