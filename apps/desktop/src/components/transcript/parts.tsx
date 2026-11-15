/** Pieces every transcript style shares: times, tool steps, the folded tool group, notes. */

import type { BotSummary, ConversationSync, ToolOutcome } from "@top/client";
import { AlertTriangle, Check, ChevronRight, CircleSlash, RotateCcw, ShieldCheck, Wrench } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { cn } from "../../lib/utils.ts";
import { jumpTo, messageParts } from "../../quotes.ts";
import type { DisplayRow, Row, ToolEntry, ToolGroupRow } from "../../rows.ts";
import { Badge } from "../ui/badge.tsx";
import { Button } from "../ui/button.tsx";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible.tsx";

export type UserRowData = Extract<Row, { kind: "user" }>;
export type AssistantRowData = Extract<Row, { kind: "assistant" }>;

/** What every style's rows get from the transcript; stable while the conversation is open, so rows memoize. */
export type RowContext = { sync: ConversationSync; name: string; avatar: number | undefined };
/** `bot` changes with every status update; only the working row reads it. */
export type RowRenderer = (rows: readonly DisplayRow[], index: number, ctx: RowContext, bot: BotSummary | undefined) => React.ReactNode;

export function time(at: number | undefined): string {
  return at ? new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
}

const DAY = 86_400_000;
const startOfDay = (at: number) => new Date(at).setHours(0, 0, 0, 0);
export const sameDay = (a: number, b: number) => startOfDay(a) === startOfDay(b);

/** "Today", "Yesterday", or "16 October 2026". */
export function dayLabel(at: number): string {
  const days = Math.round((startOfDay(Date.now()) - startOfDay(at)) / DAY);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return new Date(at).toLocaleDateString([], { day: "numeric", month: "long", year: "numeric" });
}

/** The time of the nearest timed row before `index`. */
export function prevTime(rows: readonly DisplayRow[], index: number): number | undefined {
  for (let i = index - 1; i >= 0; i--) {
    const r = rows[i]!;
    if (r.kind === "user" || r.kind === "assistant" || r.kind === "toolgroup") return r.at;
  }
  return undefined;
}

/** Seconds since the bot started what it's doing, ticking. */
export function useElapsed(bot: BotSummary | undefined): number {
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 1_000);
    return () => clearInterval(timer);
  }, []);
  return bot ? Math.max(0, Math.floor((Date.now() - bot.since) / 1000)) : 0;
}

export function ErrorNote({ children, className }: { children: React.ReactNode; className?: string | undefined }) {
  return (
    <div
      className={cn(
        "mt-2 inline-flex items-center gap-1.5 rounded-md bg-destructive-surface px-2.5 py-1.25 text-meta leading-snug font-label text-destructive-foreground",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function AnswerError({ error, className }: { error: string; className?: string }) {
  return (
    <ErrorNote className={className}>
      {error === "Stopped" ? <CircleSlash size={13} strokeWidth={2.2} /> : <AlertTriangle size={13} strokeWidth={2.2} />}
      {error === "Stopped" ? "Stopped" : `Failed: ${error}`}
    </ErrorNote>
  );
}

/** The chevron of a disclosure: points right, turns down while its panel is open. */
export const chevron = "transition-transform duration-120 group-data-panel-open/disclosure:rotate-90";

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
export function StepIcon({ className, children }: { className: string; children: React.ReactNode }) {
  return (
    <span className={cn("grid size-4.5 flex-none place-items-center rounded-full", className)} aria-hidden>
      {children}
    </span>
  );
}

const failedStep = (entry: ToolEntry) => !!entry.isError || entry.outcome === "interrupted" || entry.outcome === "stopped";

/** One finished tool call on one line; truncated output opens below. */
const ToolStep = memo(function ToolStep({ entry, sync }: { entry: ToolEntry; sync: ConversationSync }) {
  const [full, setFull] = useState<string | undefined>();
  const failed = failedStep(entry);
  return (
    <Collapsible
      className="py-0.75 text-small"
      onOpenChange={(open) => {
        if (open && full === undefined)
          void sync.detail(entry.seq).then(
            (e) => setFull(e?.kind === "tool" ? e.text : ""),
            () => setFull("Couldn't load."),
          );
      }}
    >
      <div className="flex min-w-0 items-center gap-2.25">
        <StepIcon className={failed ? "bg-destructive-surface text-destructive" : "bg-success-surface text-success-foreground"}>
          {failed ? <AlertTriangle size={12} strokeWidth={2.4} /> : <Check size={12} strokeWidth={2.4} />}
        </StepIcon>
        <span className="flex-none font-mono text-code font-medium text-foreground [font-variant-ligatures:none]">{entry.name}</span>
        <span className="min-w-0 flex-1 truncate text-secondary-foreground">{entry.text}</span>
        {entry.outcome && <Outcome outcome={entry.outcome} failed={failed} />}
        {entry.truncated && (
          <CollapsibleTrigger render={<Button variant="link" size="link" className="group/disclosure flex-none gap-0.5" />}>
            <span className="group-data-panel-open/disclosure:hidden">Full output</span>
            <span className="hidden group-data-panel-open/disclosure:inline">Hide</span>
            <ChevronRight size={12} strokeWidth={2.4} className={chevron} />
          </CollapsibleTrigger>
        )}
      </div>
      <CollapsiblePanel
        render={<pre />}
        className="mt-1.5 mb-0.5 ml-6.75 max-h-80 overflow-auto rounded-xl border bg-code px-3 py-2.5 font-mono text-code leading-5 whitespace-pre-wrap text-code-foreground [font-variant-ligatures:none]"
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

/** "bash, read, grep +2": the distinct tool names, in order. */
function toolNames(entries: readonly ToolEntry[]): string {
  const names = [...new Set(entries.map((e) => e.name))];
  return names.length > 3 ? `${names.slice(0, 3).join(", ")} +${names.length - 3}` : names.join(", ");
}

/**
 * A run of tool calls as one quiet line ("Used 4 tools · bash, read"), opening into the steps.
 * `trigger` styles the line for the transcript style it sits in.
 */
export const ToolGroup = memo(function ToolGroup({
  row,
  sync,
  className,
  trigger,
  panel,
}: {
  row: ToolGroupRow;
  sync: ConversationSync;
  className?: string;
  trigger?: string;
  panel?: string;
}) {
  const failed = row.entries.filter(failedStep).length;
  const count = row.entries.length;
  return (
    <Collapsible className={cn("text-small", className)}>
      <CollapsibleTrigger
        className={cn(
          "group/disclosure inline-flex max-w-full items-center gap-1.5 rounded-md py-0.5 text-meta font-label text-muted-foreground transition-colors duration-120 hover:text-secondary-foreground",
          trigger,
        )}
      >
        <Wrench size={12} strokeWidth={2.2} className="flex-none" />
        <span className="flex-none">{count === 1 ? "Used 1 tool" : `Used ${count} tools`}</span>
        <span className="min-w-0 truncate font-book opacity-80">· {toolNames(row.entries)}</span>
        {failed > 0 && <span className="flex-none text-destructive-foreground">· {failed} failed</span>}
        <ChevronRight size={12} strokeWidth={2.4} className={cn("flex-none", chevron)} />
      </CollapsibleTrigger>
      <CollapsiblePanel className={cn("mt-1 border-l-2 border-border pl-3", panel)}>
        {row.entries.map((entry) => (
          <ToolStep key={entry.seq} entry={entry} sync={sync} />
        ))}
      </CollapsiblePanel>
    </Collapsible>
  );
});

const USER_STATE: Record<NonNullable<UserRowData["state"]>, string> = {
  sending: "Sending…",
  accepted: "Sent",
  queued: "Queued",
  steer: "Steering",
  failed: "Not sent",
};

/** A pending message's state ("Queued", "Not sent · Retry · Discard"), or nothing once it's in. */
export function UserState({ row, sync, className }: { row: UserRowData; sync: ConversationSync; className?: string }) {
  if (!row.state) return null;
  const failed = row.state === "failed";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-meta leading-tight tabular-nums",
        failed ? "text-destructive-foreground" : "text-muted-foreground",
        className,
      )}
    >
      {failed && <AlertTriangle size={12} strokeWidth={2.4} />}
      {USER_STATE[row.state]}
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
    </span>
  );
}

/** A pending message's bubble treatment, shared by the bubble styles. */
export const USER_BUBBLE_STATE: Record<NonNullable<UserRowData["state"]>, string | undefined> = {
  sending: "opacity-65",
  accepted: undefined,
  queued: "bg-transparent! text-foreground inset-ring-[1.5px] inset-ring-input",
  steer: "inset-ring-[1.5px] inset-ring-primary",
  failed: "inset-ring-[1.5px] inset-ring-destructive",
};

/** Three dots bouncing in turn: the bot is thinking. */
export function Dots({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex gap-0.5", className)}>
      <i className="size-0.75 animate-bounce-dot rounded-full bg-current" />
      <i className="size-0.75 animate-bounce-dot rounded-full bg-current [animation-delay:0.15s]" />
      <i className="size-0.75 animate-bounce-dot rounded-full bg-current [animation-delay:0.3s]" />
    </span>
  );
}

export function RetryNote({ bot }: { bot: BotSummary | undefined }) {
  if (bot?.status !== "retrying" || !bot.error) return null;
  return (
    <ErrorNote>
      <RotateCcw size={13} strokeWidth={2.2} /> Retrying: {bot.error}
    </ErrorNote>
  );
}

/**
 * HTML from markdown.ts: model text rendered with raw HTML off, so it is escaped; the one place it
 * enters the DOM. `answer` is the seq of the bot's answer it shows, which makes its text quotable (Quotes.tsx).
 */
export function Markdown({ html, answer }: { html: string; answer?: number }) {
  // biome-ignore lint/security/noDangerouslySetInnerHtml: markdown.ts escapes the text (markdown-it with html: false, hljs)
  return <div className="md" data-answer={answer} dangerouslySetInnerHTML={{ __html: html }} />;
}

/**
 * What you sent. Passages you quoted (quotes.ts) show where you put them, each with your comment on
 * it, and take you back to the answer they came from. Its parent keeps line breaks.
 */
export function UserText({ text, bot }: { text: string; bot: string }) {
  const parts = useMemo(() => messageParts(text), [text]);
  if (!parts) return text;
  return parts.map((part, i) =>
    part.kind === "text" ? (
      part.text.trim() && (
        // biome-ignore lint/suspicious/noArrayIndexKey: parts of an immutable message
        <span key={i} className="my-1 block first:mt-0 last:mb-0">
          {part.text.trim()}
        </span>
      )
    ) : (
      <button
        // biome-ignore lint/suspicious/noArrayIndexKey: parts of an immutable message
        key={i}
        type="button"
        title="Show in the answer"
        className="my-1.5 block w-full cursor-pointer rounded-lg bg-current/6 px-2.5 py-1.5 text-left transition-colors duration-90 first:mt-0.5 last:mb-0.5 hover:bg-current/10"
        onClick={() => jumpTo(bot, part)}
      >
        <span className="line-clamp-4 border-l-2 border-current/30 pl-2 text-[0.93em] opacity-75">{part.text}</span>
        {part.comment && <span className="mt-1 block">{part.comment}</span>}
      </button>
    ),
  );
}

/** A rule across the column with a short line in the middle: "Load earlier messages", notices. */
export const DIVIDER =
  "flex items-center gap-3 py-4 text-meta leading-snug font-medium text-muted-foreground before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border";

export function AutoLoad({ onVisible, label }: { onVisible: () => Promise<void>; label: string }) {
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
  // Load as soon as the marker is rendered, i.e. scrolled into (over)view; once.
  // biome-ignore lint/correctness/useExhaustiveDependencies: on mount only
  useEffect(() => {
    run();
  }, []);
  return (
    <div className={DIVIDER}>
      <Button variant="link" size="link" onClick={run} disabled={busy}>
        {busy ? "Loading…" : failed ? `Couldn't load. ${label}` : label}
      </Button>
    </div>
  );
}
