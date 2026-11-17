import { Popover } from "@base-ui/react/popover";
import { TextQuote } from "lucide-react";
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { cn } from "../lib/utils.ts";
import { addQuote, rangeText } from "../quotes.ts";
import { Button } from "./ui/button.tsx";

export type Anchor = Element | { getBoundingClientRect(): DOMRect; contextElement?: Element | undefined };

const POPUP =
  "origin-(--transform-origin) rounded-xl bg-popover shadow-popover transition duration-100 outline-none data-ending-style:scale-98 data-ending-style:opacity-0 data-starting-style:scale-98 data-starting-style:opacity-0 [-webkit-app-region:no-drag]";

export function CommentPopover({
  anchor,
  quote,
  initial,
  onSave,
  onClose,
}: {
  anchor: Anchor;
  quote: string;
  initial: string;
  onSave: (comment: string) => void;
  onClose: () => void;
}) {
  const [comment, setComment] = useState(initial);
  return (
    <Popover.Root open onOpenChange={(open) => !open && onClose()}>
      <Popover.Portal>
        <Popover.Positioner anchor={anchor} side="bottom" align="start" sideOffset={8} collisionPadding={12} className="z-40">
          <Popover.Popup initialFocus={false} finalFocus={false} className={cn(POPUP, "flex w-88 max-w-[calc(100vw-24px)] flex-col gap-2 p-2.5")}>
            <blockquote className="line-clamp-3 border-l-2 border-ring pl-2.5 text-meta whitespace-pre-wrap text-secondary-foreground [overflow-wrap:anywhere]">
              {quote}
            </blockquote>
            <textarea
              // biome-ignore lint/a11y/noAutofocus: the box opens because you asked to comment
              autoFocus
              onFocus={(e) => e.currentTarget.setSelectionRange(comment.length, comment.length)}
              value={comment}
              rows={3}
              placeholder="Add an optional comment…"
              aria-label="Comment"
              className="resize-none rounded-lg bg-muted px-2.5 py-2 text-small leading-5 text-foreground outline-none placeholder:text-muted-foreground focus-visible:shadow-focus"
              onChange={(e) => setComment(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  onSave(comment);
                }
              }}
            />
            <div className="flex justify-end gap-1.5">
              <Button variant="outline" size="xs" className="px-2.5" onClick={onClose}>
                Cancel
              </Button>
              <Button size="xs" className="px-2.5" onClick={() => onSave(comment)}>
                Save
              </Button>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function rangeAnchor(range: Range, context: Element | null): Anchor {
  let last: DOMRect | undefined;
  return {
    getBoundingClientRect() {
      if (range.startContainer.isConnected) {
        const rects = range.getClientRects();
        last = rects[rects.length - 1] ?? range.getBoundingClientRect();
      }
      return last ?? new DOMRect();
    },
    contextElement: context ?? undefined,
  };
}

export function highlight(name: "quote" | "quote-found", range: Range | null) {
  if (!("highlights" in CSS)) return;
  if (range) CSS.highlights.set(name, new Highlight(range));
  else CSS.highlights.delete(name);
}

type Picked = { range: Range; seq: number; text: string; anchor: Anchor };

export function QuoteMenu({ bot, container }: { bot: string; container: RefObject<HTMLElement | null> }) {
  const [picked, setPicked] = useState<Picked | null>(null);
  const [commenting, setCommenting] = useState(false);
  const commentingRef = useRef(false);
  commentingRef.current = commenting;

  useEffect(() => {
    const check = () => {
      if (commentingRef.current) return;
      const selection = getSelection();
      const root = container.current;
      if (!selection || selection.isCollapsed || !selection.rangeCount || !root) return setPicked(null);
      const range = selection.getRangeAt(0);
      const node = range.commonAncestorContainer;
      const answer = (node instanceof Element ? node : node.parentElement)?.closest("[data-answer]");
      const seq = Number(answer?.getAttribute("data-answer"));
      if (!answer || !root.contains(answer) || !seq) return setPicked(null);
      const text = rangeText(range);
      if (!text) return setPicked(null);
      const kept = range.cloneRange();
      setPicked({ range: kept, seq, text, anchor: rangeAnchor(kept, root) });
    };
    const later = () => requestAnimationFrame(check);
    const onKey = (e: KeyboardEvent) => {
      if (e.shiftKey || e.key === "Shift") later();
    };
    const onChange = () => {
      if (!commentingRef.current && getSelection()?.isCollapsed) setPicked(null);
    };
    document.addEventListener("mouseup", later);
    document.addEventListener("keyup", onKey);
    document.addEventListener("selectionchange", onChange);
    return () => {
      document.removeEventListener("mouseup", later);
      document.removeEventListener("keyup", onKey);
      document.removeEventListener("selectionchange", onChange);
    };
  }, [container]);

  useEffect(() => {
    const el = container.current;
    if (!picked || commenting || !el) return;
    const onScroll = () => {
      if (!picked.range.startContainer.isConnected) setPicked(null);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [picked, commenting, container]);

  const close = useCallback(() => {
    highlight("quote", null);
    setCommenting(false);
    setPicked(null);
  }, []);
  useEffect(() => () => highlight("quote", null), []);

  if (!picked) return null;
  if (commenting)
    return (
      <CommentPopover
        anchor={picked.anchor}
        quote={picked.text}
        initial=""
        onClose={close}
        onSave={(comment) => {
          addQuote(bot, picked.seq, picked.text, comment);
          close();
        }}
      />
    );
  return (
    <Popover.Root open onOpenChange={(open) => !open && setPicked(null)}>
      <Popover.Portal>
        <Popover.Positioner anchor={picked.anchor} side="top" align="end" sideOffset={6} collisionPadding={12} className="z-40">
          <Popover.Popup initialFocus={false} finalFocus={false} className={cn(POPUP, "rounded-lg p-0.5")}>
            <Button
              variant="ghost"
              size="xs"
              className="px-2 text-secondary-foreground"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                commentingRef.current = true;
                setCommenting(true);
                highlight("quote", picked.range);
                getSelection()?.removeAllRanges();
              }}
            >
              <TextQuote size={13} strokeWidth={2.2} />
              Quote
            </Button>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
