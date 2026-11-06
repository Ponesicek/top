import { memo, useEffect, useState, useSyncExternalStore } from "react";
import { WifiOff } from "lucide-react";
import type { ConversationSync } from "@top/client";
import { cn } from "../lib/utils.ts";
import { isWorking } from "../rows.ts";
import { useBot } from "../top.ts";
import { Avatar } from "./Avatar.tsx";
import { statusLabel } from "./Sidebar.tsx";
import { StatusDot } from "./StatusDot.tsx";
import { Badge } from "./ui/badge.tsx";

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

/** The header shares the transcript's column: its avatar sits on the avatar rail. */
export const Header = memo(function Header({ sync, name }: { sync: ConversationSync; name: string }) {
  const bot = useBot(sync.id);
  const working = isWorking(bot?.status);
  const status = useSyncExternalStore(sync.subscribe, () => sync.getSnapshot().status);
  const state = bot?.status ?? "idle";
  return (
    <header className="h-15 flex-none overflow-hidden border-b [scrollbar-gutter:stable] [-webkit-app-region:drag] [&_button]:[-webkit-app-region:no-drag]">
      <div className="mx-auto flex h-full max-w-220 items-center justify-between gap-4 px-8">
        <div className="flex min-w-0 items-center gap-[11px]">
          <Avatar name={name} size="sm" />
          <div className="flex min-w-0 flex-col">
            <h1 className="m-0 text-base leading-tight font-[650] tracking-[-0.01em]">{name}</h1>
            <span
              className={cn(
                "inline-flex min-w-0 items-center gap-1.5 text-meta leading-[1.35] font-medium whitespace-nowrap",
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
      </div>
    </header>
  );
});
