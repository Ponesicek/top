import { useAtomValue } from "@effect/atom-react";
import type { BotId, ConversationSync } from "@top/client";
import { Files, WifiOff } from "lucide-react";
import { memo, useEffect, useState } from "react";
import { FILES_TOGGLE_ID, toggleFiles, useBotFiles } from "../files.ts";
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

/**
 * Shows and hides the Files panel. It sits at the window's top-right corner, over the header or the panel's, so it
 * stays in one place whether the panel is open or not.
 */
export function FilesToggle({ bot, open }: { bot: BotId; open: boolean }) {
  const count = useBotFiles(bot)?.files.length;
  if (count === undefined) return null;
  return (
    <div className="fixed top-0 right-[calc(var(--titlebar-inset)+1rem)] z-30 flex h-15 items-center narrow:right-[calc(var(--titlebar-inset)+0.5rem)]">
      <Tooltip content={`${open ? "Hide" : "Show"} files (Ctrl+Shift+E)`} side="bottom">
        <Button
          id={FILES_TOGGLE_ID}
          variant="ghost"
          className={cn("h-8 flex-none gap-1.5 px-2.5 narrow:h-11 narrow:min-w-11", open && "bg-foreground/7 text-foreground")}
          onClick={toggleFiles}
          aria-pressed={open}
          aria-expanded={open}
          aria-controls={open ? "files-panel" : undefined}
          aria-label={`Files, ${count}`}
        >
          <Files size={16} />
          <span className="text-meta tabular-nums">{count}</span>
        </Button>
      </Tooltip>
    </div>
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
          "mx-auto flex h-full max-w-220 items-center justify-between gap-4 pl-8 [--column:55rem] narrow:pr-20",
          filesOpen ? "pr-8" : "clear-window-controls [--controls-gap:6.5rem]",
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
      </div>
    </header>
  );
});
