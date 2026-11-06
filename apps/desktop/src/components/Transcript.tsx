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
import { cn } from "../lib/utils.ts";
import { Avatar } from "./Avatar.tsx";
import { Empty, EmptyCard } from "./Empty.tsx";
import { statusLabel } from "./Sidebar.tsx";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "./ui/collapsible.tsx";

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

/**
 * A message's time: shown on hover, and reachable by keyboard (one tab stop per message, not per paragraph).
 * `hover` reveals it while the pointer is on the message (user rows; bot rows show it per paragraph instead).
 */
function MessageTime({ at, hover = false }: { at: number | undefined; hover?: boolean }) {
  if (!at) return null;
  return (
    <time
      className={cn(
        "pointer-events-none flex-none rounded text-xs leading-6 whitespace-nowrap text-muted-foreground tabular-nums opacity-0 transition-opacity duration-120 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
        hover && "group-hover/msg:opacity-100",
      )}
      dateTime={new Date(at).toISOString()}
      tabIndex={0}
    >
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

const USER_STATE: Record<NonNullable<Extract<Row, { kind: "user" }>["state"]>, { label: string; bubble?: string }> = {
  sending: { label: "Sending…", bubble: "opacity-65" },
  accepted: { label: "Sent" },
  queued: { label: "Queued", bubble: "bg-transparent text-foreground shadow-[inset_0_0_0_1.5px_var(--color-input)]" },
  steer: { label: "Steering", bubble: "shadow-[inset_0_0_0_1.5px_var(--color-primary)]" },
  failed: { label: "Not sent", bubble: "shadow-[inset_0_0_0_1.5px_var(--color-destructive)]" },
};

const UserRow = memo(function UserRow({ row, sync, divided }: { row: Extract<Row, { kind: "user" }>; sync: ConversationSync; divided: boolean }) {
  const state = row.state ? USER_STATE[row.state] : undefined;
  const failed = row.state === "failed";
  return (
    <div className="group/msg flex flex-col items-end pt-4 pb-0.5">
      <div className="flex w-full items-center justify-end gap-2.5">
        {!divided && <MessageTime at={row.at} hover />}
        <div className={cn("max-w-[min(78%,600px)] rounded-[18px_18px_6px_18px] bg-message px-4 py-2.5 whitespace-pre-wrap text-message-foreground shadow-message [overflow-wrap:anywhere]", state?.bubble)}>
          {row.text}
        </div>
      </div>
      {state && (
        <div className={cn("mt-[5px] inline-flex items-center gap-1 text-meta leading-[1.3] tabular-nums", failed ? "text-destructive-foreground" : "text-muted-foreground")}>
          {failed && <AlertTriangle size={12} strokeWidth={2.4} />}
          {state.label}
          {failed && row.requestId && (
            <>
              {" · "}
              <Button variant="link" size="link" onClick={() => sync.retry(row.requestId!)}>
                Retry
              </Button>
              {" · "}
              <Button variant="link" size="link" onClick={() => sync.discard(row.requestId!)}>
                Discard
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  );
});

function ErrorNote({ children }: { children: React.ReactNode }) {
  return <div className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-destructive-surface px-2.5 py-[5px] text-meta leading-[1.4] font-[550] text-destructive-foreground">{children}</div>;
}

/** The chevron of a disclosure: points right, turns down while its panel is open. */
const chevron = "transition-transform duration-120 group-data-[panel-open]/disclosure:rotate-90";

/** An answer right after another answer or a tool step continues the same turn: no second avatar or name. */
const AssistantRow = memo(function AssistantRow({ row, name, sync, cont, divided }: { row: Extract<Row, { kind: "assistant" }>; name: string; sync: ConversationSync; cont: boolean; divided: boolean }) {
  const html = useMemo(() => renderCached(row.key, row.text), [row]);
  const [thinking, setThinking] = useState<string | undefined>();
  return (
    <div
      className={cn("relative flex gap-3 pb-1", cont ? "pt-1.5" : "pt-[9px]")}
      style={divided || !row.at ? undefined : ({ "--t": JSON.stringify(time(row.at)) } as React.CSSProperties)}
    >
      {cont ? <span className="w-7 flex-none" /> : <Avatar name={name} size="sm" className="-mt-0.5" title={`${name} · ${time(row.at)}`} />}
      {/* Pointer: the time appears beside the paragraph or block under it (styles.css, from --t). Keyboard:
          this focusable time shows at the top of the answer, in the margin left of the avatars. */}
      {!divided && (
        <span className={cn("absolute right-[calc(100%+12px)] no-margin:hidden", cont ? "top-1.5" : "top-[11px]")}>
          <MessageTime at={row.at} />
        </span>
      )}
      <div className="min-w-0 flex-1">
        {row.hasThinking && (
          <Collapsible
            className="mt-0.5 mb-1.5 text-small text-secondary-foreground"
            onOpenChange={(open) => {
              if (open && thinking === undefined)
                void sync.detail(row.seq).then((entry) => setThinking(entry.kind === "assistant" ? (entry.thinking ?? "") : ""), () => setThinking("Couldn't load."));
            }}
          >
            <CollapsibleTrigger className="group/disclosure inline-flex items-center gap-1 rounded-md font-[550] text-muted-foreground hover:text-secondary-foreground">
              <ChevronRight size={13} strokeWidth={2.2} className={chevron} /> Thought process
            </CollapsibleTrigger>
            <CollapsiblePanel>
              <p className="mt-1.5 mb-1 border-l-2 border-input pl-3 whitespace-pre-wrap">{thinking ?? "Loading…"}</p>
            </CollapsiblePanel>
          </Collapsible>
        )}
        {row.text && <div className="md" dangerouslySetInnerHTML={{ __html: html }} />}
        {row.error && (
          <ErrorNote>
            {row.error === "Stopped" ? <CircleSlash size={13} strokeWidth={2.2} /> : <AlertTriangle size={13} strokeWidth={2.2} />}
            {row.error === "Stopped" ? "Stopped" : `Failed: ${row.error}`}
          </ErrorNote>
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

/** The 18px circle every step starts with: green done, red failed, amber or blue while live. */
function StepIcon({ className, children }: { className: string; children: React.ReactNode }) {
  return (
    <span className={cn("grid size-[18px] flex-none place-items-center rounded-full", className)} aria-hidden>
      {children}
    </span>
  );
}

/** Tool steps: one compact line per finished tool call, aligned with the answer text. */
const ToolRow = memo(function ToolRow({ entry, sync }: { entry: ToolEntry; sync: ConversationSync }) {
  const [full, setFull] = useState<string | undefined>();
  const failed = entry.isError || entry.outcome === "interrupted" || entry.outcome === "stopped";
  return (
    <Collapsible
      className="mt-1 ml-10 py-1 text-small"
      onOpenChange={(open) => {
        if (open && full === undefined) void sync.detail(entry.seq).then((e) => setFull(e.kind === "tool" ? e.text : ""), () => setFull("Couldn't load."));
      }}
    >
      <div className="flex min-w-0 items-center gap-[9px]">
        <StepIcon className={failed ? "bg-destructive-surface text-destructive" : "bg-success-surface text-success-foreground"}>
          {failed ? <AlertTriangle size={12} strokeWidth={2.4} /> : <Check size={12} strokeWidth={2.4} />}
        </StepIcon>
        <span className="flex-none font-mono text-[13px] leading-[1.4] font-medium text-foreground [font-variant-ligatures:none]">{entry.name}</span>
        <span className="min-w-0 flex-1 truncate text-secondary-foreground">{entry.text}</span>
        {entry.outcome && <Outcome outcome={entry.outcome} failed={failed} />}
        {entry.truncated && (
          <CollapsibleTrigger render={<Button variant="link" size="link" className="group/disclosure flex-none gap-0.5" />}>
            <span className="group-data-[panel-open]/disclosure:hidden">Full output</span>
            <span className="hidden group-data-[panel-open]/disclosure:inline">Hide</span>
            <ChevronRight size={12} strokeWidth={2.4} className={chevron} />
          </CollapsibleTrigger>
        )}
      </div>
      <CollapsiblePanel
        render={<pre />}
        className="mt-1.5 mb-0.5 ml-[27px] max-h-80 overflow-auto rounded-xl border bg-code px-3 py-2.5 font-mono text-[13px] leading-[1.55] whitespace-pre-wrap text-code-foreground [font-variant-ligatures:none]"
      >
        {full ?? "Loading…"}
      </CollapsiblePanel>
    </Collapsible>
  );
});

function Outcome({ outcome, failed }: { outcome: ToolOutcome; failed: boolean }) {
  const Icon = OUTCOME_ICON[outcome];
  return (
    <Badge size="md" variant={failed ? "destructive" : outcome === "recovered" || outcome === "replayed" ? "tool" : "warning"}>
      <Icon size={11} strokeWidth={2.6} />
      {OUTCOME_LABEL[outcome]}
    </Badge>
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
  const tool = bot?.status === "tool";
  return (
    <div className={cn("relative flex gap-3 pb-1", cont ? "pt-1.5" : "pt-[9px]")}>
      {cont ? <span className="w-7 flex-none" /> : <Avatar name={name} size="sm" className="-mt-0.5" />}
      <div className="min-w-0 flex-1">
        <div className={cn("inline-flex items-center gap-[9px] text-small leading-6 font-medium text-secondary-foreground", !cont && "mt-0.5")}>
          {/* The live step uses the same circle as finished steps: amber while thinking, blue while a tool runs. */}
          <StepIcon className={tool ? "bg-tool-surface text-tool" : "bg-warning-surface text-warning"}>
            {tool ? (
              <Loader2 size={12} strokeWidth={2.4} className="animate-spin motion-reduce:animate-none" />
            ) : (
              <span className="inline-flex gap-0.5">
                <i className="size-[3px] animate-bounce-dot rounded-full bg-current" />
                <i className="size-[3px] animate-bounce-dot rounded-full bg-current [animation-delay:0.15s]" />
                <i className="size-[3px] animate-bounce-dot rounded-full bg-current [animation-delay:0.3s]" />
              </span>
            )}
          </StepIcon>
          {bot ? statusLabel(bot) : "Working"}
          {seconds >= 2 && <span className="text-meta text-muted-foreground tabular-nums"> · {seconds} s</span>}
        </div>
        {bot?.status === "retrying" && bot.error && (
          <ErrorNote>
            <RotateCcw size={13} strokeWidth={2.2} /> Retrying: {bot.error}
          </ErrorNote>
        )}
      </div>
    </div>
  );
}

/** A rule across the column with a short line in the middle: "Load earlier messages", notices. */
const DIVIDER =
  "flex items-center gap-3 py-4 text-meta leading-[1.4] font-medium text-muted-foreground before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border";

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
    <div className={DIVIDER}>
      <Button variant="link" size="link" onClick={run} disabled={busy}>
        {busy ? "Loading…" : failed ? `Couldn't load. ${label}` : label}
      </Button>
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
    <div className="transcript relative flex-1 overflow-y-auto [contain:strict] [overflow-anchor:none] [scrollbar-gutter:stable]" ref={scrollRef} onScroll={onScroll} onClick={onClick}>
      <div ref={innerRef} className="relative mx-auto w-full max-w-220" style={{ height: virtualizer.getTotalSize() }}>
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
            <div
              key={item.key}
              data-index={item.index}
              ref={virtualizer.measureElement}
              className="row absolute top-0 left-0 w-full px-8 will-change-transform narrow:px-4"
              style={{ transform: `translateY(${item.start}px)` }}
            >
              {/* Opens a stretch of conversation: a centered, quiet time. */}
              {showTime && (row.kind === "user" || row.kind === "assistant") && row.at ? (
                <div className="pt-5 pb-1 text-center text-meta leading-4 font-medium text-muted-foreground tabular-nums">{stretchLabel(row.at)}</div>
              ) : null}
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
                <div className={DIVIDER}>{row.text}</div>
              )}
            </div>
          );
        })}
      </div>
      {rows.length === 0 && (
        <Empty>
          {snapshot.status === "loading" ? (
            <EmptyCard visual={<Avatar name={name} size="lg" />}>Connecting to {name}…</EmptyCard>
          ) : (
            <EmptyCard visual={<Avatar name={name} size="lg" />} title={name}>
              No messages yet. Say hi and give {name} something to do.
            </EmptyCard>
          )}
        </Empty>
      )}
    </div>
  );
});
