/**
 * The virtualized transcript. Only on-screen rows exist in the DOM; rows are memoized by identity,
 * so a new message renders one new row. Nothing streams: answers arrive whole, tool calls show as
 * steps, and a "working" row says what the bot is doing while it does it.
 *
 * Scroll rules: stick to the bottom while the user is at the bottom; never yank them down if they
 * scrolled up; keep the visible row in place when older messages load above it.
 */
import { useVirtualizer } from "@tanstack/react-virtual";
import type { ConversationSnapshot, ConversationSync } from "@top/client";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { ChatStyle } from "../chatStyle.ts";
import { openFile } from "../files.ts";
import { copyCode } from "../lib/copyCode.ts";
import { cn } from "../lib/utils.ts";
import { perf } from "../perf.ts";
import { findPassage, onJump } from "../quotes.ts";
import { committedRows, type DisplayRow, displayRows, isWorking, type Row, tailRows } from "../rows.ts";
import { useBot, useConversation } from "../top.ts";
import { Avatar } from "./Avatar.tsx";
import { Empty, EmptyCard } from "./Empty.tsx";
import { FilesLine } from "./files/FilesLine.tsx";
import { highlight, QuoteMenu } from "./Quotes.tsx";
import { renderChatRow } from "./transcript/ChatRows.tsx";
import { renderDefaultRow } from "./transcript/DefaultRows.tsx";
import { PermissionCard } from "./transcript/PermissionCard.tsx";
import { AutoLoad, DIVIDER, type RowContext, type RowRenderer } from "./transcript/parts.tsx";
import { renderTeamRow } from "./transcript/TeamRows.tsx";

const BOTTOM_SLACK = 48;
const scrollMemory = new Map<string, { offset: number; atBottom: boolean }>();

function estimate(row: DisplayRow | undefined): number {
  if (!row) return 80;
  if (row.kind === "user") return 64 + Math.ceil(row.text.length / 90) * 22 + (row.attachments ? 200 : 0);
  if (row.kind === "assistant") return 80 + Math.ceil(row.text.length / 110) * 24;
  if (row.kind === "toolgroup" || row.kind === "files") return 34;
  if (row.kind === "permission") return 120;
  return 48;
}

/** Each style: how it renders a row, and how the column around the rows is laid out. */
const STYLES: Record<ChatStyle, { render: RowRenderer; scroll?: string; inner: string; row: string; files: string }> = {
  // `files`: where the line saying which files changed starts, under the style's answers.
  default: { render: renderDefaultRow, inner: "max-w-220", row: "px-8 narrow:px-4", files: "pl-10" },
  team: { render: renderTeamRow, inner: "max-w-none", row: "px-0", files: "pr-4 pl-18" },
  chat: { render: renderChatRow, inner: "max-w-240", row: "px-[5%] narrow:px-2", files: "pl-2" },
};

/** Committed rows plus tail rows, as one array that keeps its identity while nothing structural changes. */
function useRows(snapshot: ConversationSnapshot, working: boolean, showTools: boolean): DisplayRow[] {
  const committed = committedRows(snapshot.items);
  const tail = tailRows(snapshot, working);
  const last = useRef<{ committed: Row[]; tail: Row[]; showTools: boolean; rows: DisplayRow[] } | null>(null);
  const prev = last.current;
  if (prev && prev.committed === committed && prev.showTools === showTools && prev.tail.length === tail.length && prev.tail.every((r, i) => r === tail[i])) {
    return prev.rows;
  }
  const rows = displayRows(tail.length ? committed.concat(tail) : committed, showTools);
  last.current = { committed, tail, showTools, rows };
  return rows;
}

export const Transcript = memo(function Transcript({
  sync,
  name,
  avatar,
  style = "default",
  showTools = false,
}: {
  sync: ConversationSync;
  name: string;
  avatar?: number | undefined;
  style?: ChatStyle;
  showTools?: boolean;
}) {
  const look = STYLES[style];
  const snapshot = useConversation(sync);
  const bot = useBot(sync.id);
  const rows = useRows(snapshot, isWorking(bot?.status), showTools);

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

  // The first visible row and its offset from the top of the viewport, to hold still across inserts above it.
  const anchor = useRef<{ key: string; offset: number } | null>(null);
  const captureAnchor = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const first = virtualizer.getVirtualItems().find((i) => i.end > el.scrollTop);
    anchor.current = first ? { key: String(first.key), offset: first.start - el.scrollTop } : null;
  }, [virtualizer]);

  // Track whether the user is at the bottom; remember the position per bot for instant switching.
  // Following the bottom ends only when the user scrolls up: content that grows between our pin and
  // the scroll event it causes must not count as "scrolled away".
  const lastTop = useRef(0);
  const onScroll = useCallback(() => {
    const el = scrollRef.current!;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_SLACK;
    atBottom.current = near || (atBottom.current && el.scrollTop >= lastTop.current);
    lastTop.current = el.scrollTop;
    scrollMemory.set(String(sync.id), { offset: el.scrollTop, atBottom: atBottom.current });
    captureAnchor();
  }, [sync.id, captureAnchor]);

  // Pin to the bottom when content grows (new rows, late measurements).
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const inner = innerRef.current;
    if (!el || !inner) return;
    const pin = () => {
      if (atBottom.current) el.scrollTop = el.scrollHeight;
      lastTop.current = el.scrollTop;
    };
    pin();
    const observer = new ResizeObserver(pin);
    observer.observe(inner);
    return () => observer.disconnect();
  }, []);

  // Keep the first visible row still when rows are inserted above it (load earlier, gap filled).
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

  // A sent quote was clicked: show the passage in its answer, paging back through history if the answer
  // isn't loaded, then center the passage itself (the row is measured by then) and light it up.
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

  // A new bot's "No messages yet" is its content too.
  const shown = snapshot.items.length > 0 || snapshot.status !== "loading";
  useEffect(() => {
    if (shown) perf.markFirstContent();
  }, [shown]);

  // Copy buttons and links to the bot's files inside rendered markdown (one delegated listener).
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
  const ctx = useMemo<RowContext>(() => ({ sync, name, avatar }), [sync, name, avatar]);

  // The default style shows a turn's time under it while the pointer is anywhere in the turn (which
  // spans several rows): one unlayered rule shows the hovered turn's time, without re-rendering rows.
  const hoveredTurn = useRef<string | null>(null);
  const turnStyle = useRef<HTMLStyleElement>(null);
  const markTurn = useCallback((turn: string | null) => {
    if (turn === hoveredTurn.current || !turnStyle.current) return;
    hoveredTurn.current = turn;
    turnStyle.current.textContent = turn ? `.turn-time[data-turn-time="${CSS.escape(turn)}"]{opacity:1}` : "";
  }, []);
  const onMouseOver = useCallback(
    (event: React.MouseEvent) => markTurn((event.target as HTMLElement).closest("[data-turn]")?.getAttribute("data-turn") ?? null),
    [markTurn],
  );
  const onMouseLeave = useCallback(() => markTurn(null), [markTurn]);

  return (
    // Delegated handlers: clicks come from the copy buttons in rendered code (real buttons, so keys work
    // too), and hover only reveals turn times, which keyboard users reach by focusing them.
    // biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents lint/a11y/useKeyWithMouseEvents: delegation, see above
    <div
      className={cn("transcript relative flex-1 overflow-y-auto bg-background [contain:strict] [overflow-anchor:none] [scrollbar-gutter:stable]", look.scroll)}
      ref={scrollRef}
      onScroll={onScroll}
      onClick={onClick}
      onMouseOver={style === "default" ? onMouseOver : undefined}
      onMouseLeave={style === "default" ? onMouseLeave : undefined}
    >
      <style ref={turnStyle} />
      <QuoteMenu bot={String(sync.id)} container={scrollRef} />
      <div ref={innerRef} className={cn("relative mx-auto w-full", look.inner)} style={{ height: virtualizer.getTotalSize() }}>
        {items.map((item) => {
          const row = rows[item.index]!;
          return (
            <div
              key={item.key}
              data-index={item.index}
              ref={virtualizer.measureElement}
              // Placed with `top`, not a transform: a transformed row (worse, one promoted with
              // will-change) gets its own GPU layer, where Chromium drops ClearType for grayscale text
              // and can land glyphs between pixels, so the conversation reads blurry beside the sidebar.
              className={cn("row absolute left-0 w-full", look.row)}
              style={{ top: item.start }}
            >
              {row.kind === "earlier" ? (
                <AutoLoad onVisible={loadEarlier} label="Load earlier messages" />
              ) : row.kind === "gap" ? (
                <AutoLoad onVisible={() => sync.fillGap(row.gap)} label="Load missed messages" />
              ) : row.kind === "notice" ? (
                <div className={DIVIDER}>{row.text}</div>
              ) : row.kind === "files" ? (
                <FilesLine row={row} bot={sync.id} className={look.files} />
              ) : row.kind === "permission" ? (
                <PermissionCard row={row} name={name} className={look.files} />
              ) : (
                look.render(rows, item.index, ctx, bot)
              )}
            </div>
          );
        })}
      </div>
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
