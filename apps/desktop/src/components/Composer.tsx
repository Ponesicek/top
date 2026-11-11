/**
 * The composer is isolated from the transcript: it subscribes only to "is the bot working", so typing
 * never waits on a transcript render. Its field is uncontrolled (composerEditor.ts), and the component
 * re-renders only when "empty" or "working" flips, not on every keystroke.
 */

import type { ConversationSync } from "@top/client";
import { ArrowUp, Square } from "lucide-react";
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { perf } from "../perf.ts";
import { clearQuotes, onQuoteAdded, type Quote, quotesOf } from "../quotes.ts";
import { isWorking } from "../rows.ts";
import { top } from "../top.ts";
import { focusEnd, insertChip, isEmpty, makeChip, readSegments, type Segment, toMessage, writeSegments } from "./composerEditor.ts";
import { CommentPopover } from "./Quotes.tsx";
import { Button } from "./ui/button.tsx";
import { Tooltip } from "./ui/tooltip.tsx";

const drafts = new Map<string, Segment[]>();

const Actions = memo(function Actions({
  empty,
  running,
  onSend,
  onStop,
}: {
  empty: boolean;
  running: boolean;
  onSend: (steer: boolean) => void;
  onStop: () => void;
}) {
  // While a bot works and there is nothing to send, the send button is Stop.
  if (running && empty)
    return (
      <Tooltip content="Stop (Esc)">
        <Button variant="stop" size="icon" onClick={onStop} aria-label="Stop">
          <Square size={12} fill="currentColor" strokeWidth={0} />
        </Button>
      </Tooltip>
    );
  return (
    // Steering is keyboard-only (Ctrl+Enter); the button sends, or queues while the bot works.
    <Tooltip content={running ? "Queue after the current task (Enter) · Ctrl+Enter steers" : "Send (Enter) · Shift+Enter for a new line"}>
      <Button size="icon" className="disabled:bg-foreground/8" disabled={empty} onClick={() => onSend(false)} aria-label={running ? "Queue" : "Send"}>
        <ArrowUp size={17} strokeWidth={1.7} />
      </Button>
    </Tooltip>
  );
});

export const Composer = memo(function Composer({ sync, name }: { sync: ConversationSync; name: string }) {
  const key = String(sync.id);
  const ref = useRef<HTMLDivElement>(null);
  const [empty, setEmpty] = useState(() => isEmpty(drafts.get(key) ?? []));
  const running = useSyncExternalStore(top.subscribe, () => isWorking(top.getSnapshot().bots.find((b) => b.id === sync.id)?.status));
  // The chip whose comment is open, and where the caret last was in the field (a quote goes there).
  const [editing, setEditing] = useState<{ quote: Quote; chip: HTMLElement } | null>(null);
  const caret = useRef<Range | null>(null);

  /** After any change: remember the draft, and say whether there's anything to send. */
  const changed = useCallback(() => {
    const segments = readSegments(ref.current!);
    if (isEmpty(segments)) drafts.delete(key);
    else drafts.set(key, segments);
    setEmpty(isEmpty(segments));
  }, [key]);

  // The draft this bot had, chips and all; and the focus, whenever another bot opens.
  useLayoutEffect(() => {
    writeSegments(ref.current!, drafts.get(key) ?? [], quotesOf(key));
    focusEnd(ref.current!);
  }, [key]);

  useEffect(() => {
    const onSelection = () => {
      const selection = getSelection();
      if (selection?.rangeCount && ref.current?.contains(selection.anchorNode)) caret.current = selection.getRangeAt(0).cloneRange();
    };
    document.addEventListener("selectionchange", onSelection);
    return () => document.removeEventListener("selectionchange", onSelection);
  }, []);

  // A quote from the transcript lands where the caret was.
  useEffect(
    () =>
      onQuoteAdded(key, (quote) => {
        insertChip(ref.current!, makeChip(quote), caret.current);
        changed();
      }),
    [key, changed],
  );

  const send = useCallback(
    (steer: boolean) => {
      const field = ref.current!;
      const message = toMessage(readSegments(field), quotesOf(key));
      if (!message) return;
      sync.send(message, running ? (steer ? "steer" : "followUp") : "followUp");
      field.replaceChildren();
      drafts.delete(key);
      clearQuotes(key);
      setEmpty(true);
    },
    [running, sync, key],
  );
  // The buttons get stable callbacks that always see the latest state.
  const latestSend = useRef(send);
  latestSend.current = send;
  const onSend = useCallback((steer: boolean) => latestSend.current(steer), []);
  const onStop = useCallback(() => void sync.abort().catch(() => {}), [sync]);

  /** A chip's ×, or the chip itself (to comment on it). */
  const onFieldClick = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as HTMLElement;
      const chip = target.closest<HTMLElement>(".quote-chip");
      if (!chip) return;
      e.preventDefault();
      if (target.closest(".quote-chip-remove")) {
        // Its trailing space goes with it.
        if (chip.nextSibling?.nodeType === Node.TEXT_NODE && (chip.nextSibling as Text).data.startsWith(" ")) (chip.nextSibling as Text).deleteData(0, 1);
        chip.remove();
        changed();
        ref.current!.focus({ preventScroll: true });
        return;
      }
      const quote = quotesOf(key).get(Number(chip.dataset.quote));
      if (quote) setEditing({ quote, chip });
    },
    [key, changed],
  );

  return (
    // The composer shares the transcript column: its text starts where answers start. The dock reserves
    // the same scrollbar gutter as the transcript, so both center on the same axis.
    <div className="flex-none overflow-hidden [scrollbar-gutter:stable]">
      <div className="mx-auto max-w-220 px-8 pt-1 pb-3 narrow:px-4 narrow:pb-2">
        {/* Clicking the padding focuses the field, a pointer convenience; the field itself takes focus from the keyboard. */}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: see above */}
        <div
          className="composer flex cursor-text items-end gap-2 rounded-bubble border border-input bg-popover p-1.75 shadow-composer transition duration-120 focus-within:shadow-composer-focus"
          onMouseDown={(e) => {
            if (e.target !== e.currentTarget) return;
            e.preventDefault();
            focusEnd(ref.current!);
          }}
        >
          {/* A typed shell prompt, the same "›" as the logo's "›_": decoration, not a control. The avatar
              column stays empty otherwise: it is you writing, not the bot. */}
          <span
            className="pointer-events-none grid h-9 w-6 flex-none place-items-center font-mono text-[17px] leading-none font-semibold text-link/70 select-none narrow:hidden"
            aria-hidden
          >
            ›
          </span>
          {/* The field's children are its own (composerEditor.ts): React renders none, so it never resets them. */}
          {/* biome-ignore lint/a11y/useSemanticElements: a textarea can't hold quote chips */}
          <div
            ref={ref}
            role="textbox"
            aria-multiline
            aria-label={`Message ${name}`}
            tabIndex={0}
            contentEditable="plaintext-only"
            data-placeholder={`Message ${name}…`}
            data-empty={empty ? "" : undefined}
            className="composer-input relative max-h-60 min-w-0 flex-1 overflow-y-auto bg-transparent py-1.75 text-body leading-6 whitespace-pre-wrap text-foreground outline-none [overflow-wrap:anywhere] data-empty:before:pointer-events-none data-empty:before:absolute data-empty:before:text-muted-foreground data-empty:before:content-[attr(data-placeholder)]"
            onInput={changed}
            onMouseDown={(e) => {
              // A chip is one thing: pressing it neither moves the caret into it nor starts a selection.
              if ((e.target as HTMLElement).closest(".quote-chip")) e.preventDefault();
            }}
            onClick={onFieldClick}
            onKeyDown={(e) => {
              perf.trackInput(e.nativeEvent);
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send(e.ctrlKey || e.metaKey);
              } else if (e.key === "Escape" && running) {
                onStop();
              }
            }}
          />
          <Actions empty={empty} running={running} onSend={onSend} onStop={onStop} />
        </div>
        {/* Only the working state's keys need explaining (idle is the usual Enter / Shift+Enter). The line
            keeps its height either way, so the transcript doesn't jump when a bot starts or stops. */}
        <div className="h-5.75 truncate pt-1.75 pl-10 text-meta leading-4 text-muted-foreground">
          {running ? "Enter queues · Ctrl+Enter steers · Esc stops" : ""}
        </div>
      </div>
      {editing && (
        <CommentPopover
          anchor={editing.chip}
          quote={editing.quote.text}
          initial={editing.quote.comment}
          onClose={() => {
            setEditing(null);
            ref.current?.focus({ preventScroll: true });
          }}
          onSave={(comment) => {
            const quote = { ...editing.quote, comment: comment.trim() };
            quotesOf(key).set(quote.id, quote);
            editing.chip.replaceWith(makeChip(quote));
            setEditing(null);
            changed();
            ref.current?.focus({ preventScroll: true });
          }}
        />
      )}
    </div>
  );
});
