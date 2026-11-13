/**
 * What a message was sent with: images as pictures (one large, several as a grid; click for full size)
 * and other files as cards that open them. Sizes are fixed before images load, so rows don't jump.
 */
import { type Attachment, MODEL_IMAGE_TYPES } from "@top/client";
import { memo, useState } from "react";
import { sizeLabel } from "../../attachments.ts";
import { cn } from "../../lib/utils.ts";
import { top } from "../../top.ts";
import { FileIcon } from "../files/FileIcon.tsx";
import { Lightbox } from "../Lightbox.tsx";

/** "PDF", "TXT", …: what a file is, in a word. */
function kindLabel(attachment: Attachment): string {
  const ext = attachment.name.includes(".") ? attachment.name.split(".").pop()! : "";
  return ext && ext.length <= 6 ? ext.toUpperCase() : attachment.mimeType === "text/plain" ? "Text" : "File";
}

export const MessageAttachments = memo(function MessageAttachments({
  attachments,
  align,
  className,
}: {
  attachments: readonly Attachment[];
  align: "start" | "end";
  className?: string;
}) {
  const [open, setOpen] = useState<number | undefined>();
  const images = attachments.filter((a) => MODEL_IMAGE_TYPES.includes(a.mimeType));
  const files = attachments.filter((a) => !images.includes(a));
  const shown = images.map((a) => ({ src: top.attachmentUrl(a.id) ?? "", name: a.name }));
  return (
    <div className={cn("flex max-w-full flex-col gap-1.5", align === "end" ? "items-end" : "items-start", className)}>
      {images.length > 0 && (
        <div className={cn("flex max-w-full flex-wrap gap-1.5", align === "end" && "justify-end")}>
          {images.map((image, i) => (
            <button
              key={image.id}
              type="button"
              className={cn(
                "flex-none cursor-zoom-in overflow-hidden rounded-xl bg-secondary shadow-message",
                images.length === 1 ? "h-48 max-w-[min(100%,360px)]" : "size-24",
              )}
              title={image.name}
              aria-label={`Show ${image.name}`}
              onClick={() => setOpen(i)}
            >
              <img
                src={shown[i]!.src}
                alt={image.name}
                loading="lazy"
                decoding="async"
                draggable={false}
                className={cn("h-full", images.length === 1 ? "w-auto max-w-full object-contain" : "w-full object-cover")}
              />
            </button>
          ))}
        </div>
      )}
      {files.map((file) => (
        <a
          key={file.id}
          href={top.attachmentUrl(file.id)}
          target="_blank"
          rel="noreferrer"
          title={`Open ${file.name}`}
          className="flex max-w-72 min-w-0 items-center gap-2.5 rounded-xl bg-secondary px-3 py-2 text-foreground no-underline transition-colors duration-90 hover:bg-foreground/8"
        >
          <FileIcon path={file.name} size={18} className="flex-none" />
          <span className="min-w-0 leading-tight">
            <span className="block truncate text-small">{file.name}</span>
            <span className="mt-0.5 block text-micro text-muted-foreground tabular-nums">
              {kindLabel(file)} · {sizeLabel(file.size)}
            </span>
          </span>
        </a>
      ))}
      {open !== undefined && <Lightbox images={shown} start={open} onClose={() => setOpen(undefined)} />}
    </div>
  );
});
