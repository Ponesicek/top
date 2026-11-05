import { memo, useSyncExternalStore } from "react";
import type { BotSummary, WireId } from "@top/client";
import { top } from "../top.ts";

const STATUS_LABEL: Record<BotSummary["status"], string> = {
  idle: "Idle",
  thinking: "Thinking",
  streaming: "Writing",
  tool: "Using a tool",
  failed: "Needs attention",
};

const BotItem = memo(function BotItem({ bot, selected, index, onSelect }: { bot: BotSummary; selected: boolean; index: number; onSelect: (id: WireId) => void }) {
  return (
    <button className={`bot ${selected ? "selected" : ""}`} onClick={() => onSelect(bot.id)} title={`${bot.name} (Ctrl+${index + 1})`}>
      <span className={`avatar s-${bot.status}`}>{bot.name[0]}</span>
      <span className="bot-text">
        <span className="bot-name">
          {bot.name}
          {bot.queued > 0 && <span className="badge">{bot.queued}</span>}
        </span>
        <span className="bot-preview">{bot.status === "idle" ? bot.preview || "Idle" : `${STATUS_LABEL[bot.status]} · ${bot.preview}`}</span>
      </span>
    </button>
  );
});

export function Sidebar({ selected, onSelect }: { selected: WireId | undefined; onSelect: (id: WireId) => void }) {
  const { bots, connection, rttMs } = useSyncExternalStore(top.subscribe, top.getSnapshot);
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
        {bots.map((bot, i) => (
          <BotItem key={String(bot.id)} bot={bot} index={i} selected={String(bot.id) === String(selected)} onSelect={onSelect} />
        ))}
      </nav>
      <div className="sidebar-foot">Ctrl+Shift+P · performance</div>
    </aside>
  );
}
