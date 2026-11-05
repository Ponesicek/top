import { memo, useSyncExternalStore } from "react";
import { Activity } from "lucide-react";
import type { BotId, BotSummary } from "@top/client";
import { serverUrl, top, useSeen } from "../top.ts";
import { Avatar } from "./Avatar.tsx";

/** The sidebar's short status, beside the name; the header spells out the tool. */
const SHORT: Record<BotSummary["status"], string> = { idle: "", thinking: "Thinking", tool: "Running", retrying: "Retrying", failed: "Failed" };

export function statusLabel(bot: BotSummary): string {
  switch (bot.status) {
    case "idle":
      return "Idle";
    case "thinking":
      return "Thinking";
    case "tool":
      return `Running ${bot.tool ?? "a tool"}`;
    case "retrying":
      return "Retrying";
    case "failed":
      return "Needs attention";
  }
}

const BotItem = memo(function BotItem({ bot, selected, unread, index, onSelect }: { bot: BotSummary; selected: boolean; unread: boolean; index: number; onSelect: (id: BotId) => void }) {
  const busy = bot.status !== "idle";
  return (
    <button className={`bot${selected ? " selected" : ""}${unread ? " unread" : ""}`} onClick={() => onSelect(bot.id)} title={`${bot.name} (Ctrl+${index + 1})`} aria-current={selected || undefined}>
      <Avatar name={bot.name} status={bot.status} />
      <span className="bot-text">
        <span className="bot-line">
          <span className="bot-name">{bot.name}</span>
          <span className={`state st-${bot.status}`} title={statusLabel(bot)}>
            <i />
            {busy ? SHORT[bot.status] : "Idle"}
          </span>
          {bot.queued > 0 && (
            <span className="badge" title={`${bot.queued} queued`}>
              {bot.queued} queued
            </span>
          )}
        </span>
        <span className="bot-line">
          {bot.preview ? <span className="bot-preview">{bot.preview}</span> : <span className="bot-preview empty-preview">No messages yet</span>}
          {unread && <span className="unread-dot" title="New messages" aria-label="New messages" />}
        </span>
      </span>
    </button>
  );
});

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function Sidebar({ selected, onSelect, onTogglePerf }: { selected: BotId | undefined; onSelect: (id: BotId) => void; onTogglePerf: () => void }) {
  const { bots, connection, rttMs } = useSyncExternalStore(top.subscribe, top.getSnapshot);
  const seen = useSeen();
  const working = bots.filter((b) => b.status !== "idle").length;
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="logo" aria-label="Top">
          <span className="logo-mark" aria-hidden>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M7 8l4 4-4 4" />
              <path d="M13 16h4.5" />
            </svg>
          </span>
          top
        </span>
        <span className="brand-right">
        <span className={`conn c-${connection}`} title={`${host(serverUrl)}${rttMs !== undefined ? ` · round trip ${rttMs} ms` : ""}`}>
          <i />
          {connection === "open" ? "Live" : connection === "connecting" ? "Connecting" : "Reconnecting"}
        </span>
        </span>
      </div>
      <div className="section-label">
        <span className="section-title">Bots</span>
        <span className={`section-count${working > 0 ? " busy" : ""}`}>{working > 0 ? `${working} working` : bots.length}</span>
      </div>
      <nav className="bots">
        {bots.map((bot, i) => {
          const isSelected = bot.id === selected;
          return <BotItem key={bot.id} bot={bot} index={i} selected={isSelected} unread={!isSelected && bot.lastSeq > (seen[bot.id] ?? 0)} onSelect={onSelect} />;
        })}
      </nav>
      <div className="sidebar-foot">
        <button className="icon-btn" onClick={onTogglePerf} title="Performance overlay (Ctrl+Shift+P)" aria-label="Performance overlay">
          <Activity size={16} strokeWidth={1.8} />
          <span>Performance</span>
        </button>
      </div>
    </aside>
  );
}
