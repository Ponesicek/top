import { useVirtualizer } from "@tanstack/react-virtual";
import type { ConversationSnapshot, ConversationSync } from "@top/client";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { openFile } from "../files.ts";
import { copyCode } from "../lib/copyCode.ts";
import { perf } from "../perf.ts";
import { findPassage, onJump } from "../quotes.ts";
import { committedRows, type DisplayRow, displayRows, isWorking, type Row, tailRows, taskQuestionRows, withTail } from "../rows.ts";
import { INPUT_MS, keyScrollsUp, onPinToEnd, stillPinned, touchScrollsUp, wheelScrollsUp } from "../scrollPin.ts";
import { useClient, useConversation } from "../top.ts";
import { Avatar } from "./Avatar.tsx";
import { Empty, EmptyCard } from "./Empty.tsx";
import { FilesLine } from "./files/FilesLine.tsx";
import { highlight, QuoteMenu } from "./Quotes.tsx";
import { AgentReceipt, TaskQuestionCard } from "./transcript/AgentCards.tsx";
import { AskCard } from "./transcript/AskCard.tsx";
import { renderChatRow } from "./transcript/ChatRows.tsx";
import { AutoLoad, type BotIdentity, DIVIDER, IdentityProvider } from "./transcript/parts.tsx";

const scrollMemory = new Map<string, { offset: number; atBottom: boolean }>();

function estimate(row: DisplayRow | undefined): number {
  if (!row) return 80;
  if (row.kind === "wake") return 0;
  if (row.kind === "user") return 64 + Math.ceil(row.text.length / 90) * 22 + (row.attachments ? 200 : 0);
  if (row.kind === "assistant") return 80 + Math.ceil(row.text.length / 110) * 24;
  if (row.kind === "toolgroup" || row.kind === "files") return 34;
  if (row.kind === "ask") return row.ask.kind === "question" && !row.answer ? 120 + row.ask.options.length * 44 : 140;
  if (row.kind === "agent") return 76;
  if (row.kind === "taskQuestion") return 140;
  return 48;
}

const FILES = "pl-2";

function useRows(snapshot: ConversationSnapshot, working: boolean, showTools: boolean, bot: number): DisplayRow[] {
  const committed = committedRows(snapshot.items);
  const waitingTasks = useClient((s) => s.waitingTasks);
  const waiting = taskQuestionRows(waitingTasks, bot);
  const queued = tailRows(snapshot, working);
  const tail = waiting.length ? [...queued, ...waiting] : queued;
  const last = useRef<{ committed: Row[]; tail: Row[]; showTools: boolean; rows: DisplayRow[] } | null>(null);
  const prev = last.current;
  if (prev && prev.committed === committed && prev.showTools === showTools && prev.tail.length === tail.length && prev.tail.every((r, i) => r === tail[i])) {
    return prev.rows;
  }
  const rows = displayRows(withTail(committed, tail), showTools);
  last.current = { committed, tail, showTools, rows };
  return rows;
}

export const Transcript = memo(function Transcript({ sync, showTools = false }: { sync: ConversationSync; showTools?: boolean }) {
  const snapshot = useConversation(sync);
  const name = useClient((s) => s.bots.find((b) => b.id === sync.id)?.name ?? "");
  const avatar = useClient((s) => s.bots.find((b) => b.id === sync.id)?.avatar);
  const working = useClient((s) => isWorking(s.bots.find((b) => b.id === sync.id)?.status));
  const identity = useMemo<BotIdentity>(() => ({ sync, name, avatar }), [sync, name, avatar]);
  const rows = useRows(snapshot, working, showTools, sync.id);

  const scrollRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const memory = scrollMemory.get(String(sync.id));
  const atBottom = useRef(memory?.atBottom ?? true);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => estimate(rows[i]),
    getItemKey: (i) => rows[i]!.key,
    overscan: 8,
    paddingStart: 8,
    paddingEnd: 20,
    initialOffset: memory && !memory.atBottom ? memory.offset : 1e9,
  });

  const anchor = useRef<{ key: string; offset: number } | null>(null);
  const captureAnchor = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const first = virtualizer.getVirtualItems().find((i) => i.end > el.scrollTop);
    anchor.current = first ? { key: String(first.key), offset: first.start - el.scrollTop } : null;
  }, [virtualizer]);

  const lastTop = useRef(0);
  // When the person last scrolled up by hand (wheel, keys, touch), and whether they're dragging the scrollbar.
  const input = useRef({ at: Number.NEGATIVE_INFINITY, dragging: false });
  const onScroll = useCallback(() => {
    const el = scrollRef.current!;
    const byPerson = input.current.dragging || performance.now() - input.current.at < INPUT_MS;
    atBottom.current = stillPinned(atBottom.current, { top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight }, lastTop.current, byPerson);
    lastTop.current = el.scrollTop;
    scrollMemory.set(String(sync.id), { offset: el.scrollTop, atBottom: atBottom.current });
    captureAnchor();
  }, [sync.id, captureAnchor]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    const inner = innerRef.current;
    if (!el || !inner) return;
    const pin = () => {
      if (atBottom.current) el.scrollTop = el.scrollHeight;
      lastTop.current = el.scrollTop;
    };
    pin();
    // The content growing, and the conversation's own box shrinking (a taller message box), both keep the end in view.
    const observer = new ResizeObserver(pin);
    observer.observe(inner);
    observer.observe(el);
    const touched = () => {
      input.current.at = performance.now();
    };
    const keys = (e: KeyboardEvent) => {
      if (keyScrollsUp(e.key, e.shiftKey)) touched();
    };
    const wheel = (e: WheelEvent) => {
      if (wheelScrollsUp(e.deltaY)) touched();
    };
    let fingerY: number | undefined;
    const fingerDown = (e: TouchEvent) => {
      fingerY = e.touches[0]?.clientY;
    };
    const fingerMove = (e: TouchEvent) => {
      const y = e.touches[0]?.clientY;
      if (y !== undefined && fingerY !== undefined && touchScrollsUp(fingerY, y)) touched();
      fingerY = y;
    };
    const grab = (e: PointerEvent) => {
      // A press on the scroll box itself, not on a row, is on its scrollbar.
      if (e.target === el) input.current.dragging = true;
    };
    const release = () => {
      if (!input.current.dragging) return;
      input.current.dragging = false;
      touched();
    };
    el.addEventListener("wheel", wheel, { passive: true });
    el.addEventListener("touchstart", fingerDown, { passive: true });
    el.addEventListener("touchmove", fingerMove, { passive: true });
    el.addEventListener("keydown", keys);
    el.addEventListener("pointerdown", grab);
    addEventListener("pointerup", release);
    addEventListener("pointercancel", release);
    const off = onPinToEnd(sync.id, () => {
      input.current = { at: Number.NEGATIVE_INFINITY, dragging: false };
      atBottom.current = true;
      pin();
      requestAnimationFrame(pin);
    });
    return () => {
      observer.disconnect();
      el.removeEventListener("wheel", wheel);
      el.removeEventListener("touchstart", fingerDown);
      el.removeEventListener("touchmove", fingerMove);
      el.removeEventListener("keydown", keys);
      el.removeEventListener("pointerdown", grab);
      removeEventListener("pointerup", release);
      removeEventListener("pointercancel", release);
      off();
    };
  }, [sync.id]);

  const firstKey = rows[0]?.key;
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs only when rows are inserted above, i.e. the first row changes
  useLayoutEffect(() => {
    const saved = anchor.current;
    if (saved && !atBottom.current) {
      const index = rows.findIndex((r) => r.key === saved.key);
      const item = index >= 0 ? virtualizer.measurementsCache[index] : undefined;
      if (item && scrollRef.current) scrollRef.current.scrollTop = item.start - saved.offset;
    }
  }, [firstKey]);
  const items = virtualizer.getVirtualItems();

  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  useEffect(() => {
    const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
    let fade: ReturnType<typeof setTimeout> | undefined;
    const off = onJump(String(sync.id), async (citation) => {
      const key = `e${citation.seq}`;
      for (let page = 0; page < 100 && !rowsRef.current.some((r) => r.key === key) && rowsRef.current[0]?.kind === "earlier"; page++) {
        await sync.loadEarlier().catch(() => {});
        await settle(30);
      }
      const index = rowsRef.current.findIndex((r) => r.key === key);
      const el = scrollRef.current;
      if (index < 0 || !el) return;
      atBottom.current = false;
      virtualizer.scrollToIndex(index, { align: "center" });
      await settle(80);
      const answer = el.querySelector(`[data-answer="${citation.seq}"]`);
      const range = answer && findPassage(answer, citation.text);
      if (!range) return;
      const box = el.getBoundingClientRect();
      const rect = range.getBoundingClientRect();
      el.scrollTop += rect.top + rect.height / 2 - (box.top + box.height / 2);
      highlight("quote-found", range);
      clearTimeout(fade);
      fade = setTimeout(() => highlight("quote-found", null), 2500);
    });
    return () => {
      off();
      clearTimeout(fade);
      highlight("quote-found", null);
    };
  }, [sync, virtualizer]);

  const shown = snapshot.items.length > 0 || snapshot.status !== "loading";
  useEffect(() => {
    if (shown) perf.markFirstContent();
  }, [shown]);

  const onClick = useCallback(
    (event: React.MouseEvent) => {
      if (copyCode(event)) return;
      const link = (event.target as HTMLElement).closest<HTMLElement>("a[data-file]");
      if (!link) return;
      event.preventDefault();
      openFile(sync.id, link.dataset.file!);
    },
    [sync],
  );

  const loadEarlier = useCallback(() => sync.loadEarlier(), [sync]);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: delegation, see above
    <div
      className="transcript relative flex-1 overflow-y-auto bg-background [contain:strict] [overflow-anchor:none] [scrollbar-gutter:stable]"
      ref={scrollRef}
      onScroll={onScroll}
      onClick={onClick}
    >
      <QuoteMenu bot={String(sync.id)} container={scrollRef} />
      <IdentityProvider value={identity}>
        <div ref={innerRef} className={"relative mx-auto w-full max-w-240"} style={{ height: virtualizer.getTotalSize() }}>
          {items.map((item) => {
            const row = rows[item.index]!;
            return (
              <div
                key={item.key}
                data-index={item.index}
                ref={virtualizer.measureElement}
                className={"row absolute left-0 w-full px-[5%] narrow:px-2"}
                style={{ top: item.start }}
              >
                {row.kind === "earlier" ? (
                  <AutoLoad onVisible={loadEarlier} label="Load earlier messages" />
                ) : row.kind === "gap" ? (
                  <AutoLoad onVisible={() => sync.fillGap(row.gap)} label="Load missed messages" />
                ) : row.kind === "wake" ? null : row.kind === "notice" ? (
                  <div className={DIVIDER}>{row.text}</div>
                ) : row.kind === "files" ? (
                  <FilesLine row={row} bot={sync.id} className={FILES} />
                ) : row.kind === "ask" ? (
                  <AskCard row={row} className={FILES} />
                ) : row.kind === "agent" ? (
                  <AgentReceipt row={row} className={FILES} />
                ) : row.kind === "taskQuestion" ? (
                  <TaskQuestionCard row={row} className={FILES} />
                ) : (
                  renderChatRow(rows, item.index)
                )}
              </div>
            );
          })}
        </div>
      </IdentityProvider>
      {rows.length === 0 && (
        <Empty>
          {snapshot.status === "loading" ? (
            <EmptyCard visual={<Avatar name={name} avatar={avatar} size="lg" />}>Connecting to {name}…</EmptyCard>
          ) : (
            <EmptyCard visual={<Avatar name={name} avatar={avatar} size="lg" />} title={name}>
              No messages yet. Say hi and give {name} something to do.
            </EmptyCard>
          )}
        </Empty>
      )}
    </div>
  );
});
