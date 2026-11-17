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
import { useClient, useConversation } from "../top.ts";
import { Avatar } from "./Avatar.tsx";
import { Empty, EmptyCard } from "./Empty.tsx";
import { FilesLine } from "./files/FilesLine.tsx";
import { highlight, QuoteMenu } from "./Quotes.tsx";
import { renderChatRow } from "./transcript/ChatRows.tsx";
import { renderDefaultRow } from "./transcript/DefaultRows.tsx";
import { PermissionCard } from "./transcript/PermissionCard.tsx";
import { AutoLoad, type BotIdentity, DIVIDER, IdentityProvider, type RowRenderer } from "./transcript/parts.tsx";
import { renderTeamRow } from "./transcript/TeamRows.tsx";

const BOTTOM_SLACK = 48;
const scrollMemory = new Map<string, { offset: number; atBottom: boolean }>();

function estimate(row: DisplayRow | undefined): number {
  if (!row) return 80;
  if (row.kind === "wake") return 0;
  if (row.kind === "user") return 64 + Math.ceil(row.text.length / 90) * 22 + (row.attachments ? 200 : 0);
  if (row.kind === "assistant") return 80 + Math.ceil(row.text.length / 110) * 24;
  if (row.kind === "toolgroup" || row.kind === "files") return 34;
  if (row.kind === "permission") return 120;
  return 48;
}

const STYLES: Record<ChatStyle, { render: RowRenderer; scroll?: string; inner: string; row: string; files: string }> = {
  default: { render: renderDefaultRow, inner: "max-w-220", row: "px-8 narrow:px-4", files: "pl-10" },
  team: { render: renderTeamRow, inner: "max-w-none", row: "px-0", files: "pr-4 pl-18" },
  chat: { render: renderChatRow, inner: "max-w-240", row: "px-[5%] narrow:px-2", files: "pl-2" },
};

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
  style = "default",
  showTools = false,
}: {
  sync: ConversationSync;
  style?: ChatStyle;
  showTools?: boolean;
}) {
  const look = STYLES[style];
  const snapshot = useConversation(sync);
  const name = useClient((s) => s.bots.find((b) => b.id === sync.id)?.name ?? "");
  const avatar = useClient((s) => s.bots.find((b) => b.id === sync.id)?.avatar);
  const working = useClient((s) => isWorking(s.bots.find((b) => b.id === sync.id)?.status));
  const identity = useMemo<BotIdentity>(() => ({ sync, name, avatar }), [sync, name, avatar]);
  const rows = useRows(snapshot, working, showTools);

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
  const onScroll = useCallback(() => {
    const el = scrollRef.current!;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_SLACK;
    atBottom.current = near || (atBottom.current && el.scrollTop >= lastTop.current);
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
    const observer = new ResizeObserver(pin);
    observer.observe(inner);
    return () => observer.disconnect();
  }, []);

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
      <IdentityProvider value={identity}>
        <div ref={innerRef} className={cn("relative mx-auto w-full", look.inner)} style={{ height: virtualizer.getTotalSize() }}>
          {items.map((item) => {
            const row = rows[item.index]!;
            return (
              <div
                key={item.key}
                data-index={item.index}
                ref={virtualizer.measureElement}
                className={cn("row absolute left-0 w-full", look.row)}
                style={{ top: item.start }}
              >
                {row.kind === "earlier" ? (
                  <AutoLoad onVisible={loadEarlier} label="Load earlier messages" />
                ) : row.kind === "gap" ? (
                  <AutoLoad onVisible={() => sync.fillGap(row.gap)} label="Load missed messages" />
                ) : row.kind === "wake" ? null : row.kind === "notice" ? (
                  <div className={DIVIDER}>{row.text}</div>
                ) : row.kind === "files" ? (
                  <FilesLine row={row} bot={sync.id} className={look.files} />
                ) : row.kind === "permission" ? (
                  <PermissionCard row={row} className={look.files} />
                ) : (
                  look.render(rows, item.index)
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
