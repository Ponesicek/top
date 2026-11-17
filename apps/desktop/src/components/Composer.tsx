import { activeSkills, type ConversationSync } from "@top/client";
import { ArrowUp, Loader2, Paperclip, Square } from "lucide-react";
import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { addAttachments, clearAttachments, LARGE_PASTE_BYTES, pastedTextName, readyAttachments, sizeLabel, useAttachments } from "../attachments.ts";
import { cn } from "../lib/utils.ts";
import { perf } from "../perf.ts";
import { clearQuotes, onQuoteAdded, type Quote, quotesOf } from "../quotes.ts";
import { isWorking } from "../rows.ts";
import { top, useClient } from "../top.ts";
import { AttachmentStrip } from "./AttachmentStrip.tsx";
import { focusEnd, insertChip, isEmpty, makeChip, readSegments, type Segment, toMessage, writeSegments } from "./composerEditor.ts";
import { CommentPopover } from "./Quotes.tsx";
import { SkillMenu } from "./SkillMenu.tsx";
import { Button } from "./ui/button.tsx";
import { Tooltip } from "./ui/tooltip.tsx";

const drafts = new Map<string, Segment[]>();

const Actions = memo(function Actions({
  empty,
  uploading,
  running,
  onSend,
  onStop,
}: {
  empty: boolean;
  uploading: boolean;
  running: boolean;
  onSend: (steer: boolean) => void;
  onStop: () => void;
}) {
  if (running && empty)
    return (
      <Tooltip content="Stop (Esc)">
        <Button variant="stop" size="icon" onClick={onStop} aria-label="Stop">
          <Square size={12} fill="currentColor" strokeWidth={0} />
        </Button>
      </Tooltip>
    );
  if (uploading)
    return (
      <Tooltip content="Uploading attachments…">
        <Button size="icon" className="disabled:bg-foreground/8" disabled aria-label="Uploading attachments">
          <Loader2 size={16} strokeWidth={2} className="animate-spin motion-reduce:animate-none" />
        </Button>
      </Tooltip>
    );
  return (
    <Tooltip content={running ? "Queue after the current task (Enter) · Ctrl+Enter steers" : "Send (Enter) · Shift+Enter for a new line"}>
      <Button size="icon" className="disabled:bg-foreground/8" disabled={empty} onClick={() => onSend(false)} aria-label={running ? "Queue" : "Send"}>
        <ArrowUp size={17} strokeWidth={1.7} />
      </Button>
    </Tooltip>
  );
});

const AttachButton = memo(function AttachButton({ onFiles }: { onFiles: (files: File[]) => void }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <Tooltip content="Attach files (or paste or drop them)">
        <Button variant="ghost" size="icon" aria-label="Attach files" onPointerDown={(e) => e.preventDefault()} onClick={() => input.current?.click()}>
          <Paperclip size={17} strokeWidth={1.8} />
        </Button>
      </Tooltip>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          onFiles([...(e.currentTarget.files ?? [])]);
          e.currentTarget.value = "";
        }}
      />
    </>
  );
});

export const Composer = memo(function Composer({ sync, name }: { sync: ConversationSync; name: string }) {
  const key = String(sync.id);
  const ref = useRef<HTMLDivElement>(null);
  const [empty, setEmpty] = useState(() => isEmpty(drafts.get(key) ?? []));
  const running = useClient((snapshot) => isWorking(snapshot.bots.find((b) => b.id === sync.id)?.status));
  const [editing, setEditing] = useState<{ quote: Quote; chip: HTMLElement } | null>(null);
  const caret = useRef<Range | null>(null);
  const files = useAttachments(key);
  const uploading = files.some((d) => d.state === "preparing" || d.state === "uploading");
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const say = useCallback((text: string, error = true) => {
    clearTimeout(noticeTimer.current);
    setNotice({ text, error });
    noticeTimer.current = setTimeout(() => setNotice(null), 7_000);
  }, []);
  useEffect(() => () => clearTimeout(noticeTimer.current), []);
  const [dropping, setDropping] = useState(false);
  const pasteInline = useRef(false);
  const skillsView = useClient((snapshot) => snapshot.skills);
  const skills = useMemo(() => (skillsView ? activeSkills(skillsView, sync.id).filter((s) => !s.error) : []), [skillsView, sync.id]);
  const [slash, setSlash] = useState<string | null>(null);
  const [picked, setPicked] = useState(0);
  const matches = slash === null ? [] : skills.filter((s) => s.name.startsWith(slash));
  const menuId = useId();
  const box = useRef<HTMLDivElement>(null);

  const attach = useCallback(
    (list: File[]) => {
      if (!list.length) return;
      if (!top.canAttach) return say("This daemon doesn't take attachments.");
      const problem = addAttachments(key, list);
      if (problem) say(problem);
      ref.current?.focus({ preventScroll: true });
    },
    [key, say],
  );

  useEffect(() => {
    const main = ref.current?.closest("main");
    if (!main) return;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes("Files");
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer!.dropEffect = "copy";
      setDropping(true);
    };
    const leave = (e: DragEvent) => {
      if (!main.contains(e.relatedTarget as Node | null)) setDropping(false);
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDropping(false);
      attach([...(e.dataTransfer?.files ?? [])]);
    };
    const end = () => setDropping(false);
    main.addEventListener("dragenter", over);
    main.addEventListener("dragover", over);
    main.addEventListener("dragleave", leave);
    main.addEventListener("drop", drop);
    window.addEventListener("dragend", end);
    return () => {
      main.removeEventListener("dragenter", over);
      main.removeEventListener("dragover", over);
      main.removeEventListener("dragleave", leave);
      main.removeEventListener("drop", drop);
      window.removeEventListener("dragend", end);
    };
  }, [attach]);

  const changed = useCallback(() => {
    const segments = readSegments(ref.current!);
    if (isEmpty(segments)) drafts.delete(key);
    else drafts.set(key, segments);
    setEmpty(isEmpty(segments));
    const typed = segments.length === 1 && typeof segments[0] === "string" ? /^\/([a-z0-9-]*)$/.exec(segments[0]) : null;
    setSlash(typed ? typed[1]! : null);
    setPicked(0);
  }, [key]);

  const pickSkill = useCallback(
    (name: string) => {
      const field = ref.current!;
      field.replaceChildren(document.createTextNode(`/${name} `));
      focusEnd(field);
      changed();
    },
    [changed],
  );

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
      const attached = readyAttachments(key);
      if ("wait" in attached) return say(attached.wait);
      if (!message && !attached.ready.length) return;
      sync.send(message, running ? (steer ? "steer" : "followUp") : "followUp", attached.ready);
      field.replaceChildren();
      drafts.delete(key);
      clearQuotes(key);
      clearAttachments(key);
      setEmpty(true);
      setSlash(null);
      setNotice(null);
    },
    [running, sync, key, say],
  );
  const latestSend = useRef(send);
  latestSend.current = send;
  const onSend = useCallback((steer: boolean) => latestSend.current(steer), []);
  const onStop = useCallback(() => void sync.abort().catch(() => {}), [sync]);

  const onFieldClick = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as HTMLElement;
      const chip = target.closest<HTMLElement>(".quote-chip");
      if (!chip) return;
      e.preventDefault();
      if (target.closest(".quote-chip-remove")) {
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
    <div className="flex-none overflow-hidden [scrollbar-gutter:stable]">
      <div className="relative mx-auto max-w-220 px-8 pt-1 pb-6 narrow:px-4">
        {matches.length > 0 && (
          <SkillMenu anchor={box} id={menuId} skills={matches} picked={Math.min(picked, matches.length - 1)} onPick={pickSkill} onHover={setPicked} />
        )}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: see above */}
        <div
          ref={box}
          className="composer flex cursor-text flex-col rounded-bubble border border-input bg-popover p-1.75 shadow-composer transition duration-120 focus-within:shadow-composer-focus"
          onMouseDown={(e) => {
            if (e.target !== e.currentTarget && !(e.target as HTMLElement).hasAttribute("data-pad")) return;
            e.preventDefault();
            if (e.button === 0) focusEnd(ref.current!);
          }}
        >
          {files.length > 0 && <AttachmentStrip bot={key} drafts={files} />}
          <div className="flex items-end gap-2" data-pad>
            <span
              className="pointer-events-none grid h-9 w-6 flex-none place-items-center font-mono text-[17px] leading-none font-semibold text-link/70 select-none narrow:hidden"
              aria-hidden
            >
              ›
            </span>
            {/* biome-ignore lint/a11y/useSemanticElements: a textarea can't hold quote chips */}
            <div
              ref={ref}
              role="textbox"
              aria-multiline
              aria-label={`Message ${name}`}
              tabIndex={0}
              contentEditable="plaintext-only"
              data-placeholder={skills.length ? `Message ${name}… / for skills` : `Message ${name}…`}
              data-empty={empty ? "" : undefined}
              className="composer-input relative max-h-60 min-w-0 flex-1 overflow-y-auto bg-transparent py-1.75 text-body leading-6 whitespace-pre-wrap text-foreground outline-none [overflow-wrap:anywhere] data-empty:before:pointer-events-none data-empty:before:absolute data-empty:before:text-muted-foreground data-empty:before:content-[attr(data-placeholder)]"
              onInput={changed}
              onMouseDown={(e) => {
                if ((e.target as HTMLElement).closest(".quote-chip")) e.preventDefault();
              }}
              onClick={onFieldClick}
              onPaste={(e) => {
                const inline = pasteInline.current;
                pasteInline.current = false;
                const pasted = [...e.clipboardData.files];
                const text = e.clipboardData.getData("text/plain");
                if (pasted.length && (!text || pasted.some((f) => f.type.startsWith("image/")))) {
                  e.preventDefault();
                  return attach(pasted);
                }
                const bytes = new Blob([text]).size;
                if (!inline && bytes > LARGE_PASTE_BYTES && top.canAttach) {
                  e.preventDefault();
                  const name = pastedTextName(key);
                  attach([new File([text], name, { type: "text/plain" })]);
                  say(`Large paste attached as ${name} (${sizeLabel(bytes)}) · Ctrl+Shift+V pastes it inline`, false);
                }
              }}
              aria-controls={matches.length ? menuId : undefined}
              aria-activedescendant={matches.length ? `${menuId}-${Math.min(picked, matches.length - 1)}` : undefined}
              onKeyDown={(e) => {
                perf.trackInput(e.nativeEvent);
                if (matches.length && !e.nativeEvent.isComposing && !e.altKey && !e.ctrlKey && !e.metaKey) {
                  const move = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
                  if (move) {
                    e.preventDefault();
                    return setPicked((i) => (Math.min(i, matches.length - 1) + move + matches.length) % matches.length);
                  }
                  if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
                    e.preventDefault();
                    return pickSkill(matches[Math.min(picked, matches.length - 1)]!.name);
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    return setSlash(null);
                  }
                }
                if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "v") pasteInline.current = true;
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  send(e.ctrlKey || e.metaKey);
                } else if (e.key === "Escape" && running) {
                  onStop();
                }
              }}
            />
            <AttachButton onFiles={attach} />
            <Actions empty={empty && !files.length} uploading={uploading} running={running} onSend={onSend} onStop={onStop} />
          </div>
        </div>
        <div
          className={cn(
            "absolute inset-x-8 bottom-0.5 h-4 truncate pr-3 pl-10 text-meta leading-4 narrow:inset-x-4 narrow:pl-3",
            notice?.error ? "text-destructive-foreground" : "text-muted-foreground",
          )}
          aria-live="polite"
        >
          {notice?.text}
        </div>
      </div>
      {dropping && (
        <div
          className="pointer-events-none absolute inset-2 z-30 grid place-items-center rounded-2xl border-2 border-dashed border-primary/60 bg-background/70"
          role="status"
        >
          <span className="inline-flex items-center gap-2 rounded-full bg-popover px-4 py-2 text-small font-label text-foreground shadow-popover">
            <Paperclip size={15} strokeWidth={2} /> Drop files to attach
          </span>
        </div>
      )}
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
