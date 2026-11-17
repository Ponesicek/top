import { useAtomValue } from "@effect/atom-react";
import type { BotId, ConversationSync } from "@top/client";
import { Files, WifiOff } from "lucide-react";
import { memo, useEffect, useState } from "react";
import { togglePanel, useBotFiles } from "../files.ts";
import { cn } from "../lib/utils.ts";
import { isWorking } from "../rows.ts";
import { conversationAtom, useBot } from "../top.ts";
import { Avatar } from "./Avatar.tsx";
import { statusLabel } from "./Sidebar.tsx";
import { StatusDot } from "./StatusDot.tsx";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
import { Tooltip } from "./ui/tooltip.tsx";

function Elapsed({ since }: { since: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 1_000);
    return () => clearInterval(timer);
  }, []);
  const s = Math.max(0, Math.floor((Date.now() - since) / 1000));
  if (s < 2) return null;
  return <> · {s < 60 ? `${s} s` : `${Math.floor(s / 60)} min`}</>;
}

function FilesToggle({ bot, open }: { bot: BotId; open: boolean }) {
  const count = useBotFiles(bot)?.files.length;
  if (count === undefined) return null;
  return (
    <Tooltip content={`${open ? "Hide" : "Show"} files (Ctrl+Shift+E)`} side="bottom">
      <Button
        variant="ghost"
        className={cn("h-8 flex-none gap-1.5 px-2.5", open && "bg-foreground/7 text-foreground")}
        onClick={togglePanel}
        aria-pressed={open}
        aria-label={`Files, ${count}`}
      >
        <Files size={16} />
        <span className="text-meta tabular-nums">{count}</span>
      </Button>
    </Tooltip>
  );
}

export const Header = memo(function Header({
  sync,
  name,
  avatar,
  filesOpen,
}: {
  sync: ConversationSync;
  name: string;
  avatar: number | undefined;
  filesOpen: boolean;
}) {
  const bot = useBot(sync.id);
  const working = isWorking(bot?.status);
  const status = useAtomValue(conversationAtom(sync), (snapshot) => snapshot.status);
  const state = bot?.status ?? "idle";
  return (
    <header className="h-15 flex-none overflow-hidden border-b [scrollbar-gutter:stable] [-webkit-app-region:drag] [&_button]:[-webkit-app-region:no-drag]">
      <div
        className={cn(
          "mx-auto flex h-full max-w-220 items-center justify-between gap-4 pl-8 [--column:55rem]",
          filesOpen ? "pr-8" : "clear-window-controls [--controls-gap:1.5rem]",
        )}
      >
        <div className="flex min-w-0 items-center gap-2.75">
          <Avatar name={name} avatar={avatar} size="sm" />
          <div className="flex min-w-0 flex-col">
            <h1 className="m-0 text-base leading-tight font-heading tracking-name">{name}</h1>
            <span
              className={cn(
                "inline-flex min-w-0 items-center gap-1.5 text-meta leading-snug font-medium whitespace-nowrap",
                state === "idle" ? "text-muted-foreground" : state === "failed" ? "text-destructive-foreground" : "text-secondary-foreground",
              )}
            >
              <StatusDot status={state} pulse />
              <span className="truncate">{bot ? statusLabel(bot) : "Idle"}</span>
              {working && bot && <Elapsed since={bot.since} />}
              {bot && bot.queued > 0 && ` · ${bot.queued} queued`}
            </span>
          </div>
          {status === "stale" && (
            <Badge
              variant="warning"
              size="xl"
              className="ml-1.5 hidden narrow:inline-flex"
              role="status"
              aria-label="Offline, showing last known state"
              title="Offline, showing last known state"
            >
              <WifiOff size={13} strokeWidth={2.2} aria-hidden />
            </Badge>
          )}
        </div>
        <FilesToggle bot={sync.id} open={filesOpen} />
      </div>
    </header>
  );
});
