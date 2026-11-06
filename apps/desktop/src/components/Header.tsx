import type { BotId, ConversationSync } from "@top/client";
import { Files, WifiOff } from "lucide-react";
import { memo, useEffect, useState, useSyncExternalStore } from "react";
import { togglePanel, useBotFiles } from "../files.ts";
import { cn } from "../lib/utils.ts";
import { isWorking } from "../rows.ts";
import { useBot } from "../top.ts";
import { Avatar } from "./Avatar.tsx";
import { statusLabel } from "./Sidebar.tsx";
import { StatusDot } from "./StatusDot.tsx";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
import { Tooltip } from "./ui/tooltip.tsx";

/** "12 s", "3 min": how long the bot has been at its current step. */
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

/** Opens and closes the Files panel; shows how many files the bot has. Kept well clear of the window buttons. */
function FilesToggle({ bot, open }: { bot: BotId; open: boolean }) {
  const count = useBotFiles(bot)?.files.length;
  // A daemon without files folders (or one that hasn't listed this bot's yet): nothing to open.
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

/** The header shares the transcript's column: its avatar sits on the avatar rail. */
export const Header = memo(function Header({ sync, name, filesOpen }: { sync: ConversationSync; name: string; filesOpen: boolean }) {
  const bot = useBot(sync.id);
  const working = isWorking(bot?.status);
  const status = useSyncExternalStore(sync.subscribe, () => sync.getSnapshot().status);
  const state = bot?.status ?? "idle";
  return (
    <header className="h-15 flex-none overflow-hidden border-b [scrollbar-gutter:stable] [-webkit-app-region:drag] [&_button]:[-webkit-app-region:no-drag]">
      {/* With the Files panel open, the window buttons sit over the panel, not here. */}
      <div
        className={cn(
          "mx-auto flex h-full max-w-220 items-center justify-between gap-4 pl-8 [--column:55rem]",
          filesOpen ? "pr-8" : "clear-window-controls [--controls-gap:1.5rem]",
        )}
      >
        <div className="flex min-w-0 items-center gap-2.75">
          <Avatar name={name} size="sm" />
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
            <Badge variant="warning" size="xl" className="stale ml-1.5">
              <WifiOff size={13} strokeWidth={2.2} /> Offline · showing last known state
            </Badge>
          )}
        </div>
        <FilesToggle bot={sync.id} open={filesOpen} />
      </div>
    </header>
  );
});
