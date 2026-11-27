import type { BotId } from "@top/client";
import { CornerUpLeft, Send } from "lucide-react";
import { memo } from "react";
import { cn } from "../../lib/utils.ts";
import { openBot } from "../../openBot.ts";
import type { DisplayRow } from "../../rows.ts";
import { useRoster } from "../../top.ts";
import { Avatar } from "../Avatar.tsx";
import { DIVIDER, time } from "./parts.tsx";

type PeerRow = Extract<DisplayRow, { kind: "peer" }>;
type SentRow = Extract<DisplayRow, { kind: "botMessage" }>;

/** The bot as it is now (its name and icon may have changed), or as the message named it once it's been deleted. */
function useBotNamed(id: BotId, name: string) {
  const bot = useRoster().find((b) => b.id === id);
  return bot ? { name: bot.name, avatar: bot.avatar, live: true } : { name, avatar: undefined, live: false };
}

function BotLink({ id, name, live }: { id: BotId; name: string; live: boolean }) {
  if (!live) return <span className="max-w-[12rem] flex-none truncate font-medium text-foreground">{name}</span>;
  return (
    <button
      type="button"
      className="max-w-[12rem] flex-none cursor-pointer truncate rounded-sm font-medium text-foreground underline-offset-2 outline-none hover:underline focus-visible:underline focus-visible:ring-2 focus-visible:ring-ring"
      title={`Open ${name}`}
      onClick={() => openBot(id)}
    >
      {name}
    </button>
  );
}

/** A message from another bot: on the side of what this bot is told, but a card, not the user's own bubble, and signed. */
export const PeerBubble = memo(function PeerBubble({ row, first }: { row: PeerRow; first: boolean }) {
  const { peer } = row;
  const from = useBotNamed(peer.bot, peer.name);
  if (peer.outcome)
    return (
      <div className={DIVIDER}>
        <span className="flex min-w-0 items-center gap-1">
          <BotLink id={peer.bot} name={from.name} live={from.live} />
          <span className="min-w-0">
            won't reply to message {peer.id}: {peer.outcome === "stopped" ? "it was stopped" : "it was deleted"}
          </span>
        </span>
      </div>
    );
  return (
    <div className={cn("flex flex-col items-end pr-2", first ? "pt-2.5" : "pt-0.5")} data-peer={peer.id}>
      <div className="flex w-fit max-w-[min(75%,540px)] min-w-[min(100%,13rem)] flex-col gap-0.5 rounded-[9px] bg-muted px-2.5 pt-1.5 pb-1.75 shadow-bubble inset-ring inset-ring-border">
        <div className="flex min-w-0 items-center gap-1.5 text-meta text-muted-foreground">
          <Avatar name={from.name} avatar={from.avatar} size="xs" />
          <BotLink id={peer.bot} name={from.name} live={from.live} />
          <span className="min-w-0 truncate">{peer.replyTo === undefined ? `· message ${peer.id}` : `· reply to message ${peer.replyTo}`}</span>
          <time className="ml-auto flex-none pl-2 text-[11px] tabular-nums" dateTime={new Date(row.at).toISOString()} title={new Date(row.at).toLocaleString()}>
            {time(row.at)}
          </time>
        </div>
        <div className="whitespace-pre-wrap text-foreground [overflow-wrap:anywhere]">{row.text}</div>
      </div>
    </div>
  );
});

/** What this bot sent another: a receipt, a couple of lines at most. */
export const SentCard = memo(function SentCard({ row, first }: { row: SentRow; first: boolean }) {
  const { message } = row;
  const to = useBotNamed(message.to, message.name);
  const reply = message.replyTo !== undefined;
  const Icon = reply ? CornerUpLeft : Send;
  return (
    <div className={cn("pl-2", first ? "pt-2.5" : "pt-0.75")} data-sent={message.id}>
      <div className="flex w-fit max-w-[min(80%,620px)] min-w-0 flex-col gap-0.5 rounded-[10px] bg-chat-in/75 px-2.75 py-1.5 shadow-bubble">
        <div className="flex min-w-0 items-center gap-1.5 text-meta text-muted-foreground">
          <Icon size={13} className="flex-none" aria-hidden />
          <span className="flex-none">{reply ? "Reply to" : `Message ${message.id} to`}</span>
          <Avatar name={to.name} avatar={to.avatar} size="xs" />
          <BotLink id={message.to} name={to.name} live={to.live} />
          {reply && <span className="min-w-0 truncate">· message {message.replyTo}</span>}
        </div>
        <p className="line-clamp-3 text-small whitespace-pre-wrap text-foreground [overflow-wrap:anywhere]" title={message.text}>
          {message.text}
        </p>
      </div>
    </div>
  );
});
