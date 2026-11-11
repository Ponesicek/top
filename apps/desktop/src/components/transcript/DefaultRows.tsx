/**
 * The default style: answers as a column of text beside the bot's avatar, your messages in bubbles on
 * the right. Tool calls fold into one quiet line, reasoning stays out of view, and a turn's time shows
 * under it while you point anywhere in it.
 */

import type { BotSummary } from "@top/client";
import { Loader2 } from "lucide-react";
import { memo, useMemo } from "react";
import { cn } from "../../lib/utils.ts";
import { renderCached } from "../../markdown.ts";
import { author, type DisplayRow, type ToolGroupRow } from "../../rows.ts";
import { Avatar } from "../Avatar.tsx";
import { statusLabel } from "../Sidebar.tsx";
import {
  AnswerError,
  type AssistantRowData,
  Dots,
  Markdown,
  prevTime,
  RetryNote,
  type RowContext,
  type RowRenderer,
  StepIcon,
  ToolGroup,
  time,
  USER_BUBBLE_STATE,
  type UserRowData,
  UserState,
  UserText,
  useElapsed,
} from "./parts.tsx";

/** The divider that opens a stretch of conversation: the time today, the day and time before that. */
function stretchLabel(at: number): string {
  const d = new Date(at);
  if (d.toDateString() === new Date().toDateString()) return time(at);
  return `${d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })} · ${time(at)}`;
}

/** A time divider opens each stretch of conversation (messages 5+ minutes apart). */
const NEW_STRETCH_MS = 5 * 60_000;

/** The key of the row that opens `index`'s turn: a bot turn spans its answers and tool groups. */
function turnOf(rows: readonly DisplayRow[], index: number): string {
  if (author(rows[index]!) !== "bot") return rows[index]!.key;
  let i = index;
  while (i > 0 && author(rows[i - 1]!) === "bot") i--;
  return rows[i]!.key;
}

/**
 * The turn's time, under its last row. The transcript reveals it (by `data-turn-time`) while the pointer is
 * anywhere in the turn; it's also one tab stop, so the keyboard can reach it.
 */
function TurnTime({ at, turn, align }: { at: number | undefined; turn: string; align: "start" | "end" }) {
  if (!at) return <div className="h-1" />;
  return (
    <div className={cn("flex h-5.5 items-center", align === "end" ? "justify-end" : "pl-10")}>
      <time
        className="turn-time rounded text-micro whitespace-nowrap text-muted-foreground tabular-nums opacity-0 transition-opacity duration-120 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        data-turn-time={turn}
        dateTime={new Date(at).toISOString()}
        title={new Date(at).toLocaleString()}
        // Focusable so keyboard users can reveal it (it shows on hover otherwise).
        // biome-ignore lint/a11y/noNoninteractiveTabindex: see above
        tabIndex={0}
      >
        {time(at)}
      </time>
    </div>
  );
}

const UserRow = memo(function UserRow({ row, ctx }: { row: UserRowData; ctx: RowContext }) {
  return (
    <div className="flex flex-col items-end pt-3" data-turn={row.key}>
      <div
        className={cn(
          "max-w-[min(78%,600px)] rounded-bubble rounded-br-md bg-message px-4 py-2.5 whitespace-pre-wrap text-message-foreground shadow-message [overflow-wrap:anywhere]",
          row.state && USER_BUBBLE_STATE[row.state],
        )}
      >
        <UserText text={row.text} bot={String(ctx.sync.id)} />
      </div>
      {row.state ? <UserState row={row} sync={ctx.sync} className="mt-1.25 mb-1" /> : <TurnTime at={row.at} turn={row.key} align="end" />}
    </div>
  );
});

/** An answer right after another answer or a tool group continues the same turn: no second avatar. */
const AssistantRow = memo(function AssistantRow({
  row,
  name,
  cont,
  turn,
  end,
}: {
  row: AssistantRowData;
  name: string;
  cont: boolean;
  turn: string;
  end: boolean;
}) {
  const html = useMemo(() => renderCached(row.key, row.text), [row]);
  return (
    <div data-turn={turn}>
      <div className={cn("flex gap-3 pb-1", cont ? "pt-1.5" : "pt-2.25")}>
        {cont ? <span className="w-7 flex-none" /> : <Avatar name={name} size="sm" className="-mt-0.5" title={name} />}
        <div className="min-w-0 flex-1">
          {row.text && <Markdown html={html} answer={row.seq} />}
          {row.error && <AnswerError error={row.error} />}
        </div>
      </div>
      {end && <TurnTime at={row.at} turn={turn} align="start" />}
    </div>
  );
});

const ToolGroupLine = memo(function ToolGroupLine({
  row,
  ctx,
  cont,
  turn,
  end,
}: {
  row: ToolGroupRow;
  ctx: RowContext;
  cont: boolean;
  turn: string;
  end: boolean;
}) {
  return (
    <div data-turn={turn}>
      <div className={cn("flex gap-3", cont ? "pt-1" : "pt-2.25")}>
        {cont ? <span className="w-7 flex-none" /> : <Avatar name={ctx.name} size="sm" className="-mt-0.5" title={ctx.name} />}
        <ToolGroup row={row} sync={ctx.sync} className="min-w-0 flex-1 py-0.5" />
      </div>
      {end && <TurnTime at={row.at} turn={turn} align="start" />}
    </div>
  );
});

/** What the bot is doing right now, with how long it has been at it. */
function WorkingRow({ name, bot, cont }: { name: string; bot: BotSummary | undefined; cont: boolean }) {
  const seconds = useElapsed(bot);
  const tool = bot?.status === "tool";
  return (
    <div className={cn("flex gap-3 pb-1", cont ? "pt-1.5" : "pt-2.25")}>
      {cont ? <span className="w-7 flex-none" /> : <Avatar name={name} size="sm" className="-mt-0.5" />}
      <div className="min-w-0 flex-1">
        <div className={cn("inline-flex items-center gap-2.25 text-small leading-6 font-medium text-secondary-foreground", !cont && "mt-0.5")}>
          {/* Amber while thinking, blue while a tool runs. */}
          <StepIcon className={tool ? "bg-tool-surface text-tool" : "bg-warning-surface text-warning"}>
            {tool ? <Loader2 size={12} strokeWidth={2.4} className="animate-spin motion-reduce:animate-none" /> : <Dots />}
          </StepIcon>
          {bot ? statusLabel(bot) : "Working"}
          {seconds >= 2 && <span className="text-meta text-muted-foreground tabular-nums"> · {seconds} s</span>}
        </div>
        <RetryNote bot={bot} />
      </div>
    </div>
  );
}

export const renderDefaultRow: RowRenderer = (rows, index, ctx, bot) => {
  const row = rows[index]!;
  const prev = rows[index - 1];
  const next = rows[index + 1];
  const cont = !!prev && author(prev) === "bot" && row.kind !== "user";
  const end = !next || author(next) !== "bot";
  // A centered time divider where a turn opens a new stretch of conversation.
  const opensTurn = row.kind === "user" || ((row.kind === "assistant" || row.kind === "toolgroup") && !cont);
  const at = opensTurn ? row.at : undefined;
  const before = at ? prevTime(rows, index) : undefined;
  const divider = !!at && (before === undefined || at - before > NEW_STRETCH_MS);
  const body =
    row.kind === "user" ? (
      <UserRow row={row} ctx={ctx} />
    ) : row.kind === "assistant" ? (
      <AssistantRow row={row} name={ctx.name} cont={cont} turn={turnOf(rows, index)} end={end} />
    ) : row.kind === "toolgroup" ? (
      <ToolGroupLine row={row} ctx={ctx} cont={cont} turn={turnOf(rows, index)} end={end} />
    ) : row.kind === "working" ? (
      <WorkingRow name={ctx.name} bot={bot} cont={cont} />
    ) : null;
  return (
    <>
      {divider && at ? (
        <div className="pt-5 pb-1 text-center text-meta leading-4 font-medium text-muted-foreground tabular-nums">{stretchLabel(at)}</div>
      ) : null}
      {body}
    </>
  );
};
