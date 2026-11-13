/**
 * The team style, like a team chat: everyone on the left, a name and time over each run of messages,
 * date rules between days, and the row you point at lit up. A run continues while the same author
 * keeps talking within a few minutes; its later rows show their time in the gutter on hover.
 */

import type { BotSummary } from "@top/client";
import { memo, useMemo } from "react";
import { cn } from "../../lib/utils.ts";
import { renderCached } from "../../markdown.ts";
import { author, type DisplayRow, rowTime, type ToolGroupRow } from "../../rows.ts";
import { Avatar } from "../Avatar.tsx";
import { statusLabel } from "../Sidebar.tsx";
import { MessageAttachments } from "./MessageAttachments.tsx";
import {
  AnswerError,
  Dots,
  Markdown,
  prevTime,
  RetryNote,
  type RowContext,
  type RowRenderer,
  sameDay,
  ToolGroup,
  time,
  UserState,
  UserText,
  useElapsed,
} from "./parts.tsx";

/** A run of messages from one author breaks after this long a pause. */
const RUN_MS = 7 * 60_000;

function stamp(at: number): string {
  const d = new Date(at);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return `Today at ${time(at)}`;
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday at ${time(at)}`;
  return `${d.toLocaleDateString()} ${time(at)}`;
}

function DateRule({ at }: { at: number }) {
  return (
    <div className="mx-4 mt-6 mb-1 flex items-center gap-2 text-micro font-semibold text-muted-foreground before:h-px before:flex-1 before:bg-input after:h-px after:flex-1 after:bg-input">
      {new Date(at).toLocaleDateString([], { day: "numeric", month: "long", year: "numeric" })}
    </div>
  );
}

function YouAvatar() {
  return (
    <span
      className="grid size-10 flex-none place-items-center rounded-full bg-primary text-body leading-none font-heading text-primary-foreground select-none"
      aria-hidden
    >
      Y
    </span>
  );
}

/**
 * One row: with a header (avatar, name, time) when it opens a run, or just its content, its time in
 * the gutter on hover.
 */
function Shell({ head, who, name, at, children }: { head: boolean; who: "user" | "bot"; name: string; at: number | undefined; children: React.ReactNode }) {
  return (
    <div className={cn("group/msg relative px-4 hover:bg-muted", head ? "mt-3.5 flex gap-4 py-1" : "py-0.5 pl-18")}>
      {head ? (
        <>
          {who === "user" ? <YouAvatar /> : <Avatar name={name} size="md" className="mt-0.5 size-10" />}
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span className="text-body leading-snug font-heading tracking-name text-foreground">{who === "user" ? "You" : name}</span>
              {who === "bot" && (
                <span className="relative -top-px rounded-sm bg-primary px-1 py-px text-[10px] leading-3.5 font-bold text-primary-foreground">BOT</span>
              )}
              {at ? (
                <time className="text-micro text-muted-foreground tabular-nums" dateTime={new Date(at).toISOString()} title={new Date(at).toLocaleString()}>
                  {stamp(at)}
                </time>
              ) : null}
            </div>
            {children}
          </div>
        </>
      ) : (
        <>
          {at ? (
            <time
              className="absolute top-1.5 left-4 w-10 text-center text-[10.5px] leading-5 text-muted-foreground tabular-nums opacity-0 group-hover/msg:opacity-100"
              dateTime={new Date(at).toISOString()}
            >
              {time(at)}
            </time>
          ) : null}
          {children}
        </>
      )}
    </div>
  );
}

const UserMessage = memo(function UserMessage({ row, ctx, head }: { row: Extract<DisplayRow, { kind: "user" }>; ctx: RowContext; head: boolean }) {
  return (
    <Shell head={head} who="user" name={ctx.name} at={row.at}>
      {row.text && (
        <div
          className={cn(
            "whitespace-pre-wrap text-foreground [overflow-wrap:anywhere]",
            row.state === "sending" && "opacity-60",
            row.state === "failed" && "text-destructive-foreground",
          )}
        >
          <UserText text={row.text} bot={String(ctx.sync.id)} />
        </div>
      )}
      {row.attachments && (
        <MessageAttachments
          attachments={row.attachments}
          align="start"
          className={cn("my-1 max-w-[min(100%,600px)]", row.state === "sending" && "opacity-60")}
        />
      )}
      <UserState row={row} sync={ctx.sync} className="mt-0.5" />
    </Shell>
  );
});

const BotMessage = memo(function BotMessage({ row, ctx, head }: { row: Extract<DisplayRow, { kind: "assistant" }>; ctx: RowContext; head: boolean }) {
  const html = useMemo(() => renderCached(row.key, row.text), [row]);
  return (
    <Shell head={head} who="bot" name={ctx.name} at={row.at}>
      {row.text && <Markdown html={html} answer={row.seq} />}
      {row.error && <AnswerError error={row.error} className="mt-1" />}
    </Shell>
  );
});

const Tools = memo(function Tools({ row, ctx, head }: { row: ToolGroupRow; ctx: RowContext; head: boolean }) {
  return (
    <Shell head={head} who="bot" name={ctx.name} at={row.at}>
      <ToolGroup row={row} sync={ctx.sync} className="py-0.5" />
    </Shell>
  );
});

/** "Atlas is running bash…", with dots, where a typing indicator would be. */
function Typing({ name, bot }: { name: string; bot: BotSummary | undefined }) {
  const seconds = useElapsed(bot);
  return (
    <div className="px-4 pt-1.5 pb-1 pl-18">
      <div className="inline-flex items-center gap-2 text-meta text-secondary-foreground">
        <Dots className="text-muted-foreground" />
        <span>
          <b className="font-heading">{name}</b> · {bot ? statusLabel(bot) : "Working"}
          {seconds >= 2 && <span className="text-muted-foreground tabular-nums"> · {seconds} s</span>}
        </span>
      </div>
      <RetryNote bot={bot} />
    </div>
  );
}

export const renderTeamRow: RowRenderer = (rows, index, ctx, bot) => {
  const row = rows[index]!;
  const prev = rows[index - 1];
  const at = rowTime(row);
  const before = prevTime(rows, index);
  const newDay = !!at && (before === undefined || !sameDay(at, before));
  const head = newDay || !prev || author(prev) !== author(row) || (!!at && before !== undefined && at - before > RUN_MS) || prev.kind === "working";
  return (
    <>
      {newDay && at ? <DateRule at={at} /> : null}
      {row.kind === "user" ? (
        <UserMessage row={row} ctx={ctx} head={head} />
      ) : row.kind === "assistant" ? (
        <BotMessage row={row} ctx={ctx} head={head} />
      ) : row.kind === "toolgroup" ? (
        <Tools row={row} ctx={ctx} head={head} />
      ) : row.kind === "working" ? (
        <Typing name={ctx.name} bot={bot} />
      ) : null}
    </>
  );
};
