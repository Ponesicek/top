import { memo, useSyncExternalStore } from "react";
import type { BotId, BotSummary } from "@top/client";
import { top, useSeen } from "../top.ts";

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
  return (
    <button className={`bot ${selected ? "selected" : ""}`} onClick={() => onSelect(bot.id)} title={`${bot.name} (Ctrl+${index + 1})`}>
      <span className={`avatar s-${bot.status}`}>{bot.name[0]}</span>
      <span className="bot-text">
        <span className="bot-name">
          {bot.name}
          {bot.queued > 0 && <span className="badge">{bot.queued}</span>}
          {unread && <span className="unread" title="New messages" />}
        </span>
        <span className="bot-preview">{bot.status === "idle" ? bot.preview || "Idle" : bot.preview ? `${statusLabel(bot)} · ${bot.preview}` : statusLabel(bot)}</span>
      </span>
    </button>
  );
});

export function Sidebar({ selected, onSelect }: { selected: BotId | undefined; onSelect: (id: BotId) => void }) {
  const { bots, connection, rttMs } = useSyncExternalStore(top.subscribe, top.getSnapshot);
  const seen = useSeen();
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="logo">top</span>
        <span className={`conn c-${connection}`} title={rttMs !== undefined ? `Round trip ${rttMs} ms` : undefined}>
          <i />
          {connection === "open" ? (rttMs !== undefined ? `${rttMs} ms` : "Live") : connection === "connecting" ? "Connecting" : "Reconnecting"}
        </span>
      </div>
      <div className="section-label">Bots</div>
      <nav className="bots">
        {bots.map((bot, i) => {
          const isSelected = bot.id === selected;
          return <BotItem key={bot.id} bot={bot} index={i} selected={isSelected} unread={!isSelected && bot.lastSeq > (seen[bot.id] ?? 0)} onSelect={onSelect} />;
        })}
      </nav>
      <div className="sidebar-foot">Ctrl+Shift+P · performance</div>
    </aside>
  );
}
