import { memo, useMemo } from "react";
import { cn } from "../../lib/utils.ts";
import { renderSegments } from "../../markdown.ts";
import { author, type DisplayRow, rowTime, type ToolGroupRow } from "../../rows.ts";
import { statusLabel } from "../Sidebar.tsx";
import { MessageAttachments } from "./MessageAttachments.tsx";
import {
  AnswerError,
  Dots,
  dayLabel,
  Markdown,
  prevTime,
  RetryNote,
  type RowRenderer,
  Sources,
  sameDay,
  ToolGroup,
  time,
  USER_BUBBLE_STATE,
  UserState,
  UserText,
  useBotStatus,
  useElapsed,
  WebSearches,
} from "./parts.tsx";

const BUBBLE = "chat-bubble relative w-fit max-w-[min(75%,540px)] rounded-[9px] pt-1.25 pr-2.25 pb-1.75 pl-2.5 shadow-bubble";

const LAST_LINE = /(<\/(?:p|li|h[1-6])>\s*(?:<\/(?:ul|ol|li|blockquote)>\s*)*)$/;

function withStampSpace(html: string, label: string): string {
  const space = `<span class="stamp-space" aria-hidden="true">${label}</span>`;
  const trimmed = html.trimEnd();
  return LAST_LINE.test(trimmed) ? trimmed.replace(LAST_LINE, `${space}$1`) : trimmed + space;
}

function Tail({ side }: { side: "in" | "out" }) {
  return side === "in" ? (
    <svg viewBox="0 0 8 13" className="absolute top-0 -left-2 h-3.25 w-2 fill-chat-in drop-shadow-[0_1px_0.5px_rgba(40,24,12,0.06)]" aria-hidden>
      <path d="M1.5 0H8v13L.6 2.6C-.3 1.5.3 0 1.5 0Z" />
    </svg>
  ) : (
    <svg viewBox="0 0 8 13" className="absolute top-0 -right-2 h-3.25 w-2 fill-chat-out" aria-hidden>
      <path d="M6.5 0H0v13l7.4-10.4C8.3 1.5 7.7 0 6.5 0Z" />
    </svg>
  );
}

function Stamp({ at }: { at: number | undefined }) {
  if (!at) return null;
  return (
    <time
      className="absolute right-2.25 bottom-1.25 text-[11px] leading-none text-muted-foreground tabular-nums"
      dateTime={new Date(at).toISOString()}
      title={new Date(at).toLocaleString()}
    >
      {time(at)}
    </time>
  );
}

function DayChip({ at }: { at: number }) {
  return (
    <div className="flex justify-center pt-4 pb-1">
      <span className="rounded-lg bg-chat-in px-3 py-1 text-meta font-label text-secondary-foreground shadow-bubble">{dayLabel(at)}</span>
    </div>
  );
}

const UserBubble = memo(function UserBubble({ row, first }: { row: Extract<DisplayRow, { kind: "user" }>; first: boolean }) {
  return (
    <div className={cn("flex flex-col items-end pr-2", first ? "pt-2.5" : "pt-0.5")}>
      {row.attachments && (
        <MessageAttachments
          attachments={row.attachments}
          align="end"
          className={cn("max-w-[min(75%,540px)]", row.text && "mb-0.75", row.state === "sending" && "opacity-65")}
        />
      )}
      {(row.text || !row.attachments) && (
        <div
          className={cn(
            BUBBLE,
            "bg-chat-out text-chat-out-foreground",
            first && !row.attachments && "rounded-tr-none",
            row.state && USER_BUBBLE_STATE[row.state],
          )}
        >
          {first && !row.attachments && <Tail side="out" />}
          <div className="whitespace-pre-wrap [overflow-wrap:anywhere]">
            <UserText text={row.text} skill={row.skill} />
            <span className="stamp-space" aria-hidden>
              {time(row.at)}
            </span>
          </div>
          <Stamp at={row.at} />
        </div>
      )}
      <UserState row={row} className="mt-1" />
    </div>
  );
});

const BotBubbles = memo(function BotBubbles({ row, first }: { row: Extract<DisplayRow, { kind: "assistant" }>; first: boolean }) {
  const segments = useMemo(() => (row.text ? renderSegments(row.key, row.text) : []), [row]);
  const last = segments.length - 1;
  return (
    <div className={cn("flex flex-col items-start gap-0.75 pl-2", first ? "pt-2.5" : "pt-0.5")} data-answer={row.seq}>
      {row.searches.length > 0 && <WebSearches row={row} className="w-fit max-w-[min(80%,620px)] rounded-[10px] bg-chat-in/75 px-2.75 py-1 shadow-bubble" />}
      {segments.map((segment, i) =>
        segment.kind === "prose" ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments of an immutable entry
          <div key={i} className={cn(BUBBLE, "bg-chat-in text-foreground", first && i === 0 && "rounded-tl-none")}>
            {first && i === 0 && <Tail side="in" />}
            <Markdown html={i === last ? withStampSpace(segment.html, time(row.at)) : segment.html} />
            {i === last && <Stamp at={row.at} />}
          </div>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments of an immutable entry
          <div key={i} className="chat-block max-w-full overflow-x-auto px-px pb-0.5">
            <Markdown html={segment.html} />
            {i === last && (
              <time className="block pt-0.5 pl-1 text-[11px] text-muted-foreground tabular-nums" dateTime={new Date(row.at).toISOString()}>
                {time(row.at)}
              </time>
            )}
          </div>
        ),
      )}
      {row.citations.length > 0 && <Sources citations={row.citations} className="mt-0.5 max-w-[min(80%,620px)] pl-1" />}
      {row.pagesRead && <Sources citations={row.pagesRead} label="Pages read" className="mt-0.5 max-w-[min(80%,620px)] pl-1" />}
      {row.error && <AnswerError error={row.error} className="mt-0 shadow-bubble" />}
    </div>
  );
});

const ToolCard = memo(function ToolCard({ row, first }: { row: ToolGroupRow; first: boolean }) {
  return (
    <div className={cn("pl-2", first ? "pt-2.5" : "pt-0.75")}>
      <ToolGroup row={row} className="w-fit max-w-[min(80%,620px)] rounded-[10px] bg-chat-in/75 px-2.75 py-1 shadow-bubble" panel="mb-1" />
    </div>
  );
});

function Typing({ first }: { first: boolean }) {
  const bot = useBotStatus();
  const seconds = useElapsed(bot);
  return (
    <div className={cn("pl-2", first ? "pt-2.5" : "pt-0.75")}>
      <div className={cn(BUBBLE, "inline-flex items-center gap-2.5 bg-chat-in py-2 text-meta text-muted-foreground", first && "rounded-tl-none")}>
        {first && <Tail side="in" />}
        <Dots className="scale-150 text-muted-foreground" />
        <span>
          {bot ? statusLabel(bot) : "Working"}
          {seconds >= 2 && <span className="tabular-nums"> · {seconds} s</span>}
        </span>
      </div>
      <RetryNote bot={bot} />
    </div>
  );
}

export const renderChatRow: RowRenderer = (rows, index) => {
  const row = rows[index]!;
  const prev = rows[index - 1];
  const at = rowTime(row);
  const before = prevTime(rows, index);
  const newDay = !!at && (before === undefined || !sameDay(at, before));
  const first = newDay || !prev || author(prev) !== author(row);
  return (
    <>
      {newDay && at ? <DayChip at={at} /> : null}
      {row.kind === "user" ? (
        <UserBubble row={row} first={first} />
      ) : row.kind === "assistant" ? (
        <BotBubbles row={row} first={first} />
      ) : row.kind === "toolgroup" ? (
        <ToolCard row={row} first={first} />
      ) : row.kind === "working" ? (
        <Typing first={first} />
      ) : null}
    </>
  );
};
