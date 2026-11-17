import type { BotSummary, Citation, ConversationSync, SkillUse, ToolOutcome, WebSearchStep } from "@top/client";
import { AlertTriangle, Check, ChevronRight, CircleSlash, Globe, RotateCcw, ShieldCheck, Wrench } from "lucide-react";
import { type ComponentProps, createContext, memo, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { cn } from "../../lib/utils.ts";
import { withBotFiles } from "../../markdown.ts";
import { jumpTo, messageParts } from "../../quotes.ts";
import type { DisplayRow, Row, ToolEntry, ToolGroupRow } from "../../rows.ts";
import { top, useBot, useClient } from "../../top.ts";
import { Avatar } from "../Avatar.tsx";
import { Badge } from "../ui/badge.tsx";
import { Button } from "../ui/button.tsx";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible.tsx";

export type UserRowData = Extract<Row, { kind: "user" }>;
export type AssistantRowData = Extract<Row, { kind: "assistant" }>;

export type BotIdentity = { readonly sync: ConversationSync; readonly name: string; readonly avatar: number | undefined };

const Identity = createContext<BotIdentity | undefined>(undefined);
export const IdentityProvider = Identity.Provider;

export function useIdentity(): BotIdentity {
  const identity = useContext(Identity);
  if (!identity) throw new Error("useIdentity outside a transcript");
  return identity;
}

export function useBotStatus(): BotSummary | undefined {
  return useBot(useIdentity().sync.id);
}

export function BotAvatar({ titled, ...props }: Omit<ComponentProps<typeof Avatar>, "name" | "avatar" | "title"> & { titled?: boolean }) {
  const { name, avatar } = useIdentity();
  return <Avatar name={name} avatar={avatar} {...(titled ? { title: name } : {})} {...props} />;
}

export type RowRenderer = (rows: readonly DisplayRow[], index: number) => React.ReactNode;

export function time(at: number | undefined): string {
  return at ? new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
}

const DAY = 86_400_000;
const startOfDay = (at: number) => new Date(at).setHours(0, 0, 0, 0);
export const sameDay = (a: number, b: number) => startOfDay(a) === startOfDay(b);

export function dayLabel(at: number): string {
  const days = Math.round((startOfDay(Date.now()) - startOfDay(at)) / DAY);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return new Date(at).toLocaleDateString([], { day: "numeric", month: "long", year: "numeric" });
}

export function prevTime(rows: readonly DisplayRow[], index: number): number | undefined {
  for (let i = index - 1; i >= 0; i--) {
    const r = rows[i]!;
    if (r.kind === "user" || r.kind === "assistant" || r.kind === "toolgroup") return r.at;
  }
  return undefined;
}

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

export function StepIcon({ className, children }: { className: string; children: React.ReactNode }) {
  return (
    <span className={cn("grid size-4.5 flex-none place-items-center rounded-full", className)} aria-hidden>
      {children}
    </span>
  );
}

const failedStep = (entry: ToolEntry) => !!entry.isError || entry.outcome === "interrupted" || entry.outcome === "stopped";

const ToolStep = memo(function ToolStep({ entry }: { entry: ToolEntry }) {
  const { sync } = useIdentity();
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

function toolNames(entries: readonly ToolEntry[]): string {
  const names = [...new Set(entries.map((e) => e.name))];
  return names.length > 3 ? `${names.slice(0, 3).join(", ")} +${names.length - 3}` : names.join(", ");
}

export const ToolGroup = memo(function ToolGroup({
  row,
  className,
  trigger,
  panel,
}: {
  row: ToolGroupRow;
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
          <ToolStep key={entry.seq} entry={entry} />
        ))}
      </CollapsiblePanel>
    </Collapsible>
  );
});

function webHref(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

function pageLabel(href: string): string {
  const url = new URL(href);
  url.searchParams.delete("utm_source");
  const path = url.pathname === "/" ? "" : url.pathname;
  return `${url.hostname.replace(/^www\./, "")}${path}${url.search}`;
}

function PageLink({ href, className, children }: { href: string; className?: string; children?: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" title={href} className={cn("min-w-0 truncate text-link hover:underline", className)}>
      {children ?? pageLabel(href)}
    </a>
  );
}

const quoted = (queries: readonly string[] | undefined) => (queries?.length ? queries.map((q) => `“${q}”`).join(", ") : "");

function SearchStep({ step, sources }: { step: WebSearchStep; sources: readonly string[] | undefined }) {
  const href = webHref(step.url);
  const verb = step.action === "search" ? "Searched" : step.action === "open_page" ? "Opened" : "Looked in";
  return (
    <div className="py-0.75 text-small">
      <div className="flex min-w-0 items-center gap-2.25">
        <StepIcon className={step.failed ? "bg-destructive-surface text-destructive" : "bg-success-surface text-success-foreground"}>
          {step.failed ? <AlertTriangle size={12} strokeWidth={2.4} /> : <Check size={12} strokeWidth={2.4} />}
        </StepIcon>
        <span className="flex-none font-medium text-foreground">{verb}</span>
        {step.action === "search" && <span className="min-w-0 truncate text-secondary-foreground">{quoted(step.queries) || "the web"}</span>}
        {step.action === "find_in_page" && step.pattern && <span className="flex-none text-secondary-foreground">for “{step.pattern}” in</span>}
        {step.action !== "search" && (href ? <PageLink href={href} /> : <span className="text-muted-foreground">a page</span>)}
        {step.failed && <span className="flex-none text-destructive-foreground">· failed</span>}
        {!step.failed && step.sourceCount ? (
          <span className="flex-none text-muted-foreground">· {step.sourceCount === 1 ? "1 source" : `${step.sourceCount} sources`}</span>
        ) : null}
      </div>
      {sources && sources.length > 0 && (
        <ul className="m-0 mt-1 ml-6.75 flex list-none flex-col gap-0.5 p-0 text-meta">
          {sources.flatMap((source) => {
            const link = webHref(source);
            return link ? (
              <li key={link} className="flex min-w-0">
                <PageLink href={link} />
              </li>
            ) : (
              []
            );
          })}
        </ul>
      )}
    </div>
  );
}

export const WebSearches = memo(function WebSearches({
  row,
  className,
  trigger,
}: {
  row: Pick<AssistantRowData, "seq" | "searches">;
  className?: string;
  trigger?: string;
}) {
  const { sync } = useIdentity();
  const [full, setFull] = useState<readonly WebSearchStep[]>();
  const steps = row.searches;
  const failed = steps.filter((s) => s.failed).length;
  const searched = steps.some((s) => s.action === "search");
  const first = steps.find((s) => s.action === "search" && s.queries?.length)?.queries?.[0];
  const pages = steps.filter((s) => s.action !== "search").length;
  return (
    <Collapsible
      className={cn("text-small", className)}
      onOpenChange={(open) => {
        if (open && full === undefined)
          void sync.detail(row.seq).then(
            (e) => setFull(e?.kind === "assistant" ? (e.searches ?? []) : []),
            () => setFull([]),
          );
      }}
    >
      <CollapsibleTrigger
        className={cn(
          "group/disclosure inline-flex max-w-full items-center gap-1.5 rounded-md py-0.5 text-meta font-label text-muted-foreground transition-colors duration-120 hover:text-secondary-foreground",
          trigger,
        )}
      >
        <Globe size={12} strokeWidth={2.2} className="flex-none" />
        <span className="flex-none">{searched ? "Searched the web" : pages === 1 ? "Read a page" : `Read ${pages} pages`}</span>
        {first && <span className="min-w-0 truncate font-book opacity-80">· “{first}”</span>}
        {steps.length > 1 && <span className="flex-none font-book opacity-80">· {steps.length} steps</span>}
        {failed > 0 && <span className="flex-none text-destructive-foreground">· {failed} failed</span>}
        <ChevronRight size={12} strokeWidth={2.4} className={cn("flex-none", chevron)} />
      </CollapsibleTrigger>
      <CollapsiblePanel className="mt-1 border-l-2 border-border pl-3">
        {steps.map((step, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the steps of an immutable answer
          <SearchStep key={i} step={step} sources={full?.[i]?.sources} />
        ))}
      </CollapsiblePanel>
    </Collapsible>
  );
});

export const Sources = memo(function Sources({ citations, className }: { citations: readonly Citation[]; className?: string }) {
  const links = citations.flatMap((c) => {
    const href = webHref(c.url);
    return href ? [{ href, title: c.title }] : [];
  });
  if (!links.length) return null;
  return (
    <div className={cn("mt-2 flex flex-wrap items-center gap-1.5", className)}>
      <span className="text-micro font-semibold text-muted-foreground">Sources</span>
      {links.map(({ href, title }, i) => (
        <a
          key={href}
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          title={`${title}\n${href}`}
          className="inline-flex h-6 max-w-[min(100%,280px)] items-center gap-1.5 rounded-full bg-secondary px-2.25 text-meta leading-none font-label text-secondary-foreground transition-colors duration-90 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          <span className="flex-none text-micro text-muted-foreground tabular-nums">{i + 1}</span>
          <span className="min-w-0 truncate">{title}</span>
          <span className="flex-none font-book text-muted-foreground">{new URL(href).hostname.replace(/^www\./, "")}</span>
        </a>
      ))}
    </div>
  );
});

const USER_STATE: Record<NonNullable<UserRowData["state"]>, string> = {
  sending: "Sending…",
  accepted: "Sent",
  queued: "Queued",
  steer: "Steering",
  failed: "Not sent",
};

export function UserState({ row, className }: { row: UserRowData; className?: string }) {
  const { sync } = useIdentity();
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

export const USER_BUBBLE_STATE: Record<NonNullable<UserRowData["state"]>, string | undefined> = {
  sending: "opacity-65",
  accepted: undefined,
  queued: "bg-transparent! text-foreground inset-ring-[1.5px] inset-ring-input",
  steer: "inset-ring-[1.5px] inset-ring-primary",
  failed: "inset-ring-[1.5px] inset-ring-destructive",
};

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

export function Markdown({ html, answer }: { html: string; answer?: number }) {
  const bot = useContext(Identity)?.sync.id;
  const hasFiles = useClient((snapshot) => snapshot.hasFiles);
  // biome-ignore lint/correctness/useExhaustiveDependencies: hasFiles changes what top.fileUrl returns
  const shown = useMemo(() => (bot === undefined ? html : withBotFiles(html, (path) => top.fileUrl(bot, path))), [html, bot, hasFiles]);
  // biome-ignore lint/security/noDangerouslySetInnerHtml: markdown.ts escapes the text (markdown-it with html: false, hljs)
  return <div className="md" data-answer={answer} dangerouslySetInnerHTML={{ __html: shown }} />;
}

function SkillTag({ skill }: { skill: SkillUse }) {
  const from = skill.source === "shared" ? "the shared library" : "the bot's own skills";
  return (
    <span
      className={cn(
        "mr-1 inline-block rounded-md bg-current/8 px-1.5 font-mono text-[0.9em] leading-[1.45]",
        skill.error && "text-destructive-foreground line-through decoration-current/50",
      )}
      title={skill.error ? `The skill ${skill.name} couldn't be used: ${skill.error}` : `Skill ${skill.name}, from ${from}\n${skill.path}`}
    >
      /{skill.name}
    </span>
  );
}

export function UserText({ text, skill }: { text: string; skill?: SkillUse | undefined }) {
  const bot = String(useIdentity().sync.id);
  const tagged = skill !== undefined && text.startsWith(`/${skill.name}`);
  const rest = tagged ? text.slice(skill.name.length + 1).replace(/^\s/, "") : text;
  const parts = useMemo(() => messageParts(rest), [rest]);
  const tag = tagged ? <SkillTag key="skill" skill={skill} /> : null;
  if (!parts) return tag ? [tag, rest] : rest;
  const shown = parts.map((part, i) =>
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
  return tag ? [tag, ...shown] : shown;
}

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
