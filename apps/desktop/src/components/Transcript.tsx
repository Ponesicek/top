/**
 * The virtualized transcript. Only on-screen rows exist in the DOM; rows are memoized by identity,
 * so a new message renders one new row. Nothing streams: answers arrive whole, tool calls show as
 * steps, and a "working" row says what the bot is doing while it does it.
 *
 * Scroll rules: stick to the bottom while the user is at the bottom; never yank them down if they
 * scrolled up; keep the visible row in place when older messages load above it.
 */
import { useVirtualizer } from "@tanstack/react-virtual";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { BotSummary, ConversationSnapshot, ConversationSync, ToolOutcome } from "@top/client";
import { renderCached } from "../markdown.ts";
import { perf } from "../perf.ts";
import { committedRows, isWorking, tailRows, type Row, type ToolEntry } from "../rows.ts";
import { useBot } from "../top.ts";
import { AlertTriangle, Check, ChevronRight, CircleSlash, Loader2, RotateCcw, ShieldCheck } from "lucide-react";
import { Avatar } from "./Avatar.tsx";
import { statusLabel } from "./Sidebar.tsx";

const BOTTOM_SLACK = 48;
const scrollMemory = new Map<string, { offset: number; atBottom: boolean }>();

function estimate(row: Row | undefined): number {
  if (!row) return 80;
  if (row.kind === "user") return 64 + Math.ceil(row.text.length / 90) * 22;
  if (row.kind === "assistant") return 80 + Math.ceil(row.text.length / 110) * 24;
  if (row.kind === "tool") return 34;
  return 48;
}

function time(at: number | undefined): string {
  return at ? new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
}

/** The divider that opens a stretch of conversation: the time today, the day and time before that. */
function stretchLabel(at: number): string {
  const d = new Date(at);
  if (d.toDateString() === new Date().toDateString()) return time(at);
  return `${d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })} · ${time(at)}`;
}

/** A message's time: shown on hover, and reachable by keyboard (one tab stop per message, not per paragraph). */
function MessageTime({ at }: { at: number | undefined }) {
  if (!at) return null;
  return (
    <time className="hover-time" dateTime={new Date(at).toISOString()} tabIndex={0}>
      {time(at)}
    </time>
  );
}

/** A time divider opens each stretch of conversation (messages 5+ minutes apart). */
const NEW_STRETCH_MS = 5 * 60_000;

/** The time of the nearest message before `index` (tool steps and the working row carry none). */
function lastTime(rows: readonly Row[], index: number): number | undefined {
  for (let i = index - 1; i >= 0; i--) {
    const r = rows[i]!;
    if (r.kind === "user" || r.kind === "assistant") return r.at;
    if (r.kind !== "tool" && r.kind !== "working") return undefined;
  }
  return undefined;
}

const UserRow = memo(function UserRow({ row, sync, divided }: { row: Extract<Row, { kind: "user" }>; sync: ConversationSync; divided: boolean }) {
  const label =
    row.state === "sending" ? "Sending…" : row.state === "accepted" ? "Sent" : row.state === "queued" ? "Queued" : row.state === "steer" ? "Steering" : row.state === "failed" ? "Not sent" : "";
  return (
    <div className={`msg user ${row.state ?? ""}`}>
      <div className="bubble-line">
        {!divided && <MessageTime at={row.at} />}
        <div className="bubble">{row.text}</div>
      </div>
      {label && (
      <div className="meta">
        {row.state === "failed" && <AlertTriangle size={12} strokeWidth={2.4} />}
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
      )}
    </div>
  );
});

/** An answer right after another answer or a tool step continues the same turn: no second avatar or name. */
const AssistantRow = memo(function AssistantRow({ row, name, sync, cont, divided }: { row: Extract<Row, { kind: "assistant" }>; name: string; sync: ConversationSync; cont: boolean; divided: boolean }) {
  const html = useMemo(() => renderCached(row.key, row.text), [row]);
  const [thinking, setThinking] = useState<string | undefined>();
  return (
    <div className={`msg assistant${cont ? " cont" : " bare"}`} style={divided || !row.at ? undefined : ({ "--t": JSON.stringify(time(row.at)) } as React.CSSProperties)}>
      {cont ? <span className="gutter" /> : <Avatar name={name} size="sm" title={`${name} · ${time(row.at)}`} />}
      {/* Pointer: the time appears beside the paragraph or block under it (CSS, from --t). Keyboard: this
          focusable time shows at the top of the answer. */}
      {!divided && (
        <span className="time-rail">
          <MessageTime at={row.at} />
        </span>
      )}
      <div className="msg-body">
      {row.hasThinking && (
        <details
          className="thinking"
          onToggle={(e) => {
            if ((e.target as HTMLDetailsElement).open && thinking === undefined)
              void sync.detail(row.seq).then((entry) => setThinking(entry.kind === "assistant" ? (entry.thinking ?? "") : ""), () => setThinking("Couldn't load."));
          }}
        >
          <summary>
            <ChevronRight size={13} strokeWidth={2.2} className="chev" /> Thought process
          </summary>
          <p>{thinking ?? "Loading…"}</p>
        </details>
      )}
      {row.text && <div className="md" dangerouslySetInnerHTML={{ __html: html }} />}
      {row.error && (
        <div className="error-note">
          {row.error === "Stopped" ? <CircleSlash size={13} strokeWidth={2.2} /> : <AlertTriangle size={13} strokeWidth={2.2} />}
          {row.error === "Stopped" ? "Stopped" : `Failed: ${row.error}`}
        </div>
      )}
      </div>
    </div>
  );
});

const OUTCOME_ICON: Record<ToolOutcome, typeof Check> = {
  interrupted: AlertTriangle,
  not_run: CircleSlash,
  recovered: ShieldCheck,
  replayed: RotateCcw,
  stopped: CircleSlash,
};

const OUTCOME_LABEL: Record<ToolOutcome, string> = {
  interrupted: "Interrupted by a restart",
  not_run: "Not run",
  recovered: "Confirmed after a restart",
  replayed: "Re-run after a restart",
  stopped: "Stopped",
};

const ToolRow = memo(function ToolRow({ entry, sync }: { entry: ToolEntry; sync: ConversationSync }) {
  const [full, setFull] = useState<string | undefined>();
  const [open, setOpen] = useState(false);
  const failed = entry.isError || entry.outcome === "interrupted" || entry.outcome === "stopped";
  return (
    <div className={`step ${failed ? "bad" : "ok"}${open ? " open" : ""}`}>
      <div className="step-line">
        <span className="step-icon">{failed ? <AlertTriangle size={12} strokeWidth={2.4} /> : <Check size={12} strokeWidth={2.4} />}</span>
        <span className="step-name">{entry.name}</span>
        <span className="step-text">{entry.text}</span>
        {entry.outcome && <Outcome outcome={entry.outcome} />}
        {entry.truncated && (
          <button
            className="link step-more"
            onClick={() => {
              setOpen((o) => !o);
              if (full === undefined) void sync.detail(entry.seq).then((e) => setFull(e.kind === "tool" ? e.text : ""), () => setFull("Couldn't load."));
            }}
          >
            {open ? "Hide" : "Full output"}
            <ChevronRight size={12} strokeWidth={2.4} className="chev" />
          </button>
        )}
      </div>
      {open && <pre className="step-full">{full ?? "Loading…"}</pre>}
    </div>
  );
});

function Outcome({ outcome }: { outcome: ToolOutcome }) {
  const Icon = OUTCOME_ICON[outcome];
  return (
    <span className={`outcome o-${outcome}`}>
      <Icon size={11} strokeWidth={2.6} />
      {OUTCOME_LABEL[outcome]}
    </span>
  );
}

/** What the bot is doing right now, with how long it has been at it. */
function WorkingRow({ bot, name, cont }: { bot: BotSummary | undefined; name: string; cont: boolean }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 1_000);
    return () => clearInterval(timer);
  }, []);
  const seconds = bot ? Math.max(0, Math.floor((Date.now() - bot.since) / 1000)) : 0;
  return (
    <div className={`msg assistant working w-${bot?.status ?? "thinking"}${cont ? " cont" : ""}`}>
      {cont ? <span className="gutter" /> : <Avatar name={name} size="sm" />}
      <div className="msg-body">
        <div className="working-label">
          <span className="step-icon live" aria-hidden>
            {bot?.status === "tool" ? (
              <Loader2 size={12} strokeWidth={2.4} className="spin" />
            ) : (
              <span className="dots">
                <i />
                <i />
                <i />
              </span>
            )}
          </span>
          {bot ? statusLabel(bot) : "Working"}
          {seconds >= 2 && <span className="meta"> · {seconds} s</span>}
        </div>
        {bot?.status === "retrying" && bot.error && (
          <div className="error-note">
            <RotateCcw size={13} strokeWidth={2.2} /> Retrying: {bot.error}
          </div>
        )}
      </div>
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
function useRows(snapshot: ConversationSnapshot, working: boolean): Row[] {
  const committed = committedRows(snapshot.items);
  const tail = tailRows(snapshot, working);
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
  const bot = useBot(sync.id);
  const rows = useRows(snapshot, isWorking(bot?.status));

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

  // A new bot's "No messages yet" is its content too.
  const shown = snapshot.items.length > 0 || snapshot.status !== "loading";
  useEffect(() => {
    if (shown) perf.markFirstContent();
  }, [shown]);

  // Copy buttons inside rendered markdown (one delegated listener).
  const onClick = useCallback((event: React.MouseEvent) => {
    const button = (event.target as HTMLElement).closest(".copy");
    if (!button) return;
    const code = button.closest(".code")?.querySelector("code")?.textContent ?? "";
    void navigator.clipboard.writeText(code).then(() => {
      const label = button.querySelector("span");
      if (!label) return;
      label.textContent = "Copied";
      button.classList.add("copied");
      setTimeout(() => {
        label.textContent = "Copy";
        button.classList.remove("copied");
      }, 1200);
    });
  }, []);

  const loadEarlier = useCallback(() => sync.loadEarlier(), [sync]);

  return (
    <div className="transcript" ref={scrollRef} onScroll={onScroll} onClick={onClick}>
      <div ref={innerRef} className="transcript-inner" style={{ height: virtualizer.getTotalSize() }}>
        {items.map((item) => {
          const row = rows[item.index]!;
          const prev = rows[item.index - 1];
          const cont = prev?.kind === "assistant" || prev?.kind === "tool";
          // One rule for both sides: a centered time divider where a turn opens a new stretch of
          // conversation (never inside a turn, between a tool step and the answer that follows it).
          const opensTurn = row.kind === "user" || (row.kind === "assistant" && !cont);
          const prevAt = opensTurn ? lastTime(rows, item.index) : undefined;
          const showTime = opensTurn && !!row.at && (prevAt === undefined || row.at - prevAt > NEW_STRETCH_MS);
          return (
            <div key={item.key} data-index={item.index} ref={virtualizer.measureElement} className="row" style={{ transform: `translateY(${item.start}px)` }}>
              {showTime && (row.kind === "user" || row.kind === "assistant") && row.at ? <div className="stretch">{stretchLabel(row.at)}</div> : null}
              {row.kind === "user" ? (
                <UserRow row={row} sync={sync} divided={showTime} />
              ) : row.kind === "assistant" ? (
                <AssistantRow row={row} name={name} sync={sync} cont={cont} divided={showTime} />
              ) : row.kind === "tool" ? (
                <ToolRow entry={row.entry} sync={sync} />
              ) : row.kind === "working" ? (
                <WorkingRow bot={bot} name={name} cont={cont} />
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
      {snapshot.status === "loading" && rows.length === 0 && (
        <div className="empty">
          <div className="empty-card">
            <Avatar name={name} size="lg" />
            <p className="empty-sub">Connecting to {name}…</p>
          </div>
        </div>
      )}
      {snapshot.status !== "loading" && rows.length === 0 && (
        <div className="empty">
          <div className="empty-card">
            <Avatar name={name} size="lg" />
            <h2>{name}</h2>
            <p className="empty-sub">No messages yet. Say hi and give {name} something to do.</p>
          </div>
        </div>
      )}
    </div>
  );
});
