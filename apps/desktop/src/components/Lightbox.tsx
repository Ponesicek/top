import { Dialog } from "@base-ui/react/dialog";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useState } from "react";
import { cn } from "../lib/utils.ts";
import { Button } from "./ui/button.tsx";

export type LightboxImage = { readonly src: string; readonly name: string };

export function Lightbox({ images, start, onClose }: { images: readonly LightboxImage[]; start: number; onClose: () => void }) {
  const [index, setIndex] = useState(start);
  const [failed, setFailed] = useState<string | undefined>();
  const image = images[index];
  const many = images.length > 1;
  const step = (by: number) => setIndex((i) => (i + by + images.length) % images.length);
  if (!image) return null;
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/80 transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <Dialog.Popup
          aria-label={image.name}
          className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 p-6 outline-none [-webkit-app-region:no-drag]"
          onKeyDown={(e) => {
            e.stopPropagation();
            if (many && e.key === "ArrowRight") step(1);
            else if (many && e.key === "ArrowLeft") step(-1);
          }}
          onClick={(e) => e.target === e.currentTarget && onClose()}
        >
          {failed === image.src ? (
            <div className="rounded-xl bg-popover px-4 py-3 text-small text-secondary-foreground">The image couldn't be loaded.</div>
          ) : (
            <img
              src={image.src}
              alt={image.name}
              className="max-h-[calc(100vh-7rem)] max-w-[92vw] rounded-lg object-contain shadow-dialog"
              onError={() => setFailed(image.src)}
            />
          )}
          <div className="flex items-center gap-2 text-small text-white/85" aria-live="polite">
            <span className="max-w-[60vw] truncate">{image.name}</span>
            {many && (
              <span className="text-white/60 tabular-nums">
                {index + 1} / {images.length}
              </span>
            )}
          </div>
          {many && (
            <>
              <NavButton side="left" label="Previous image" onClick={() => step(-1)} />
              <NavButton side="right" label="Next image" onClick={() => step(1)} />
            </>
          )}
          <Dialog.Close
            render={
              <Button variant="ghost" size="icon" className="absolute top-4 right-4 text-white/80 hover:bg-white/12 hover:text-white" aria-label="Close" />
            }
          >
            <X size={18} />
          </Dialog.Close>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function NavButton({ side, label, onClick }: { side: "left" | "right"; label: string; onClick: () => void }) {
  const Icon = side === "left" ? ChevronLeft : ChevronRight;
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={label}
      className={cn("absolute top-1/2 -translate-y-1/2 text-white/80 hover:bg-white/12 hover:text-white", side === "left" ? "left-4" : "right-4")}
      onClick={onClick}
    >
      <Icon size={22} />
    </Button>
  );
}
