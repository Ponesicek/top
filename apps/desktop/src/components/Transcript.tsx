/**
 * The virtualized transcript. Only on-screen rows exist in the DOM; committed rows are memoized by
 * identity, so while a bot streams, the only row that re-renders is the live one.
 *
 * Scroll rules: stick to the bottom while the user is at the bottom; never yank them down if they
 * scrolled up; keep the visible row in place when older messages load above it.
 */
import { useVirtualizer } from "@tanstack/react-virtual";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ConversationSnapshot, ConversationSync } from "@top/client";
import { renderCached, renderMarkdown } from "../markdown.ts";
import { perf } from "../perf.ts";
import { committedRows, liveText, tailRows, type Row } from "../rows.ts";

const BOTTOM_SLACK = 48;
const scrollMemory = new Map<string, { offset: number; atBottom: boolean }>();

function estimate(row: Row | undefined): number {
  if (!row) return 80;
  if (row.kind === "user") return 64 + Math.ceil(row.text.length / 90) * 22;
  if (row.kind === "assistant") return 80 + Math.ceil(row.text.length / 110) * 24;
  return 48;
}

function time(at: number | undefined): string {
  return at ? new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
}

const UserRow = memo(function UserRow({ row, sync }: { row: Extract<Row, { kind: "user" }>; sync: ConversationSync }) {
  const label =
    row.state === "sending" ? "Sending…" : row.state === "accepted" ? "Sent" : row.state === "queued" ? "Queued" : row.state === "steer" ? "Steering" : row.state === "failed" ? "Not sent" : time(row.at);
  return (
    <div className={`msg user ${row.state ?? ""}`}>
      <div className="bubble">{row.text}</div>
      <div className="meta">
        {label}
        {row.state === "failed" && row.requestId && (
          <>
            {" · "}
            <button className="link" onClick={() => sync.retry(row.requestId!)}>Retry</button>
            {" · "}
            <button className="link" onClick={() => sync.discard(row.requestId!)}>Discard</button>
          </>
        )}
      </div>
    </div>
  );
});

const AssistantRow = memo(function AssistantRow({ row, name }: { row: Extract<Row, { kind: "assistant" }>; name: string }) {
  const html = useMemo(() => renderCached(row.key, row.text), [row]);
  return (
    <div className="msg assistant">
      <div className="who">
        {name} <span className="meta">{time(row.at)}</span>
      </div>
      {row.thinking && (
        <details className="thinking">
          <summary>Thinking</summary>
          <p>{row.thinking}</p>
        </details>
      )}
      <div className="md" dangerouslySetInnerHTML={{ __html: html }} />
      {row.tools.length > 0 && (
        <div className="tools">
          {row.tools.map((tool, i) => (
            <span key={i} className="chip">{tool}</span>
          ))}
        </div>
      )}
      {row.error && <div className="error-note">Stopped: {row.error}</div>}
    </div>
  );
});

function LiveRow({ snapshot, name }: { snapshot: ConversationSnapshot; name: string }) {
  const text = liveText(snapshot);
  const html = useMemo(() => (text ? renderMarkdown(text) : ""), [text]);
  const retry = snapshot.live?.generation?.retry;
  return (
    <div className="msg assistant live">
      <div className="who">
        {name} <span className="meta">{text ? "writing" : "thinking"}</span>
      </div>
      {text ? <div className="md streaming" dangerouslySetInnerHTML={{ __html: html }} /> : <div className="dots"><i /><i /><i /></div>}
      {retry && <div className="error-note">Retrying: {retry.error}</div>}
    </div>
  );
}

function AutoLoad({ onVisible, label }: { onVisible: () => Promise<void>; label: string }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const run = useCallback(() => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    onVisible()
      .catch(() => setFailed(true))
      .finally(() => setBusy(false));
  }, [busy, onVisible]);
  useEffect(() => {
    run();
    // load as soon as the marker is rendered, i.e. scrolled into (over)view
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="marker">
      <button className="link" onClick={run} disabled={busy}>
        {busy ? "Loading…" : failed ? `Couldn't load. ${label}` : label}
      </button>
    </div>
  );
}

/** Committed rows plus tail rows, as one array that keeps its identity while nothing structural changes. */
function useRows(snapshot: ConversationSnapshot): Row[] {
  const committed = committedRows(snapshot.items);
  const tail = tailRows(snapshot);
  const last = useRef<{ committed: Row[]; tail: Row[]; rows: Row[] } | null>(null);
  const prev = last.current;
  if (prev && prev.committed === committed && prev.tail.length === tail.length && prev.tail.every((r, i) => r === tail[i])) {
    return prev.rows;
  }
  const rows = tail.length ? committed.concat(tail) : committed;
  last.current = { committed, tail, rows };
  return rows;
}

export const Transcript = memo(function Transcript({ sync, name }: { sync: ConversationSync; name: string }) {
  const snapshot = useSyncExternalStore(sync.subscribe, sync.getSnapshot);
  const rows = useRows(snapshot);

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
  const onScroll = useCallback(() => {
    const el = scrollRef.current!;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_SLACK;
    scrollMemory.set(String(sync.id), { offset: el.scrollTop, atBottom: atBottom.current });
    captureAnchor();
  }, [sync.id, captureAnchor]);

  // Pin to the bottom when content grows (streaming text, new rows, late measurements).
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const inner = innerRef.current;
    if (!el || !inner) return;
    const pin = () => {
      if (atBottom.current) el.scrollTop = el.scrollHeight;
    };
    pin();
    const observer = new ResizeObserver(pin);
    observer.observe(inner);
    return () => observer.disconnect();
  }, []);

  // Keep the first visible row still when rows are inserted above it (load earlier, gap filled).
  const firstKey = rows[0]?.key;
  useLayoutEffect(() => {
    const saved = anchor.current;
    if (saved && !atBottom.current) {
      const index = rows.findIndex((r) => r.key === saved.key);
      const item = index >= 0 ? virtualizer.measurementsCache[index] : undefined;
      if (item && scrollRef.current) scrollRef.current.scrollTop = item.start - saved.offset;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstKey]);
  const items = virtualizer.getVirtualItems();

  useEffect(() => {
    if (snapshot.items.length) perf.markFirstContent();
  }, [snapshot.items.length]);

  // Copy buttons inside rendered markdown (one delegated listener).
  const onClick = useCallback((event: React.MouseEvent) => {
    const button = (event.target as HTMLElement).closest(".copy");
    if (!button) return;
    const code = button.closest(".code")?.querySelector("code")?.textContent ?? "";
    void navigator.clipboard.writeText(code).then(() => {
      button.textContent = "Copied";
      setTimeout(() => (button.textContent = "Copy"), 1200);
    });
  }, []);

  const loadEarlier = useCallback(() => sync.loadEarlier(), [sync]);

  return (
    <div className="transcript" ref={scrollRef} onScroll={onScroll} onClick={onClick}>
      <div ref={innerRef} className="transcript-inner" style={{ height: virtualizer.getTotalSize() }}>
        {items.map((item) => {
          const row = rows[item.index]!;
          return (
            <div key={item.key} data-index={item.index} ref={virtualizer.measureElement} className="row" style={{ transform: `translateY(${item.start}px)` }}>
              {row.kind === "user" ? (
                <UserRow row={row} sync={sync} />
              ) : row.kind === "assistant" ? (
                <AssistantRow row={row} name={name} />
              ) : row.kind === "live" ? (
                <LiveRow snapshot={snapshot} name={name} />
              ) : row.kind === "earlier" ? (
                <AutoLoad onVisible={loadEarlier} label="Load earlier messages" />
              ) : row.kind === "gap" ? (
                <AutoLoad onVisible={() => sync.fillGap(row.gap)} label="Load missed messages" />
              ) : (
                <div className="notice">{row.text}</div>
              )}
            </div>
          );
        })}
      </div>
      {snapshot.status === "loading" && rows.length === 0 && <div className="empty">Connecting to {name}…</div>}
      {snapshot.status !== "loading" && rows.length === 0 && <div className="empty">No messages yet. Say hi to {name}.</div>}
    </div>
  );
});
