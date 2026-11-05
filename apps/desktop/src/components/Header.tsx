import { memo, useEffect, useState, useSyncExternalStore } from "react";
import { Square, WifiOff } from "lucide-react";
import type { ConversationSync } from "@top/client";
import { isWorking } from "../rows.ts";
import { useBot } from "../top.ts";
import { Avatar } from "./Avatar.tsx";
import { statusLabel } from "./Sidebar.tsx";

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

export const Header = memo(function Header({ sync, name }: { sync: ConversationSync; name: string }) {
  const bot = useBot(sync.id);
  const working = isWorking(bot?.status);
  const status = useSyncExternalStore(sync.subscribe, () => sync.getSnapshot().status);
  return (
    <header className="header">
      <div className="header-inner">
      <div className="title">
        <Avatar name={name} size="sm" />
        <div className="title-text">
          <h1>{name}</h1>
          <span className={`subtitle st-${bot?.status ?? "idle"}`}>
            <i className="pulse-dot" />
            <span className="subtitle-text">{bot ? statusLabel(bot) : "Idle"}</span>
            {working && bot && <Elapsed since={bot.since} />}
            {bot && bot.queued > 0 && ` · ${bot.queued} queued`}
          </span>
        </div>
        {status === "stale" && (
          <span className="stale">
            <WifiOff size={13} strokeWidth={2.2} /> Offline · showing last known state
          </span>
        )}
      </div>
      {working && (
        <button className="stop" onClick={() => void sync.abort().catch(() => {})} title="Stop (Esc)">
          <Square size={11} fill="currentColor" strokeWidth={0} /> Stop
        </button>
      )}
      </div>
    </header>
  );
});
