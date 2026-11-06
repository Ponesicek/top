import { memo, useState, useSyncExternalStore } from "react";
import { Activity, Plus, Trash2 } from "lucide-react";
import type { BotId, BotSummary } from "@top/client";
import { serverUrl, top, useSeen } from "../top.ts";
import { Avatar } from "./Avatar.tsx";
import { DeleteBotDialog } from "./BotDialogs.tsx";

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

const BotItem = memo(function BotItem({
  bot,
  selected,
  unread,
  index,
  onSelect,
  onDelete,
}: {
  bot: BotSummary;
  selected: boolean;
  unread: boolean;
  index: number;
  onSelect: (id: BotId) => void;
  onDelete: (bot: BotSummary) => void;
}) {
  const busy = bot.status !== "idle";
  // A working bot shows its work, not "unread"; an idle bot with something new swaps its gray ring for blue.
  const fresh = unread && !busy;
  const shortcut = index < 9 ? ` (Ctrl+${index + 1})` : "";
  return (
    <div className="bot-row">
      <button
        className={`bot${selected ? " selected" : ""}${fresh ? " unread" : ""}`}
        onClick={() => onSelect(bot.id)}
        title={bot.description ? `${bot.name}${shortcut}\n${bot.description}` : `${bot.name}${shortcut}`}
        aria-current={selected || undefined}
      >
        <Avatar name={bot.name} status={bot.status} />
        <span className="bot-text">
          <span className="bot-line">
            <span className="bot-name">{bot.name}</span>
            <span className={`state st-${bot.status}${fresh ? " fresh" : ""}`} title={fresh ? "Idle · new messages" : statusLabel(bot)}>
              <i />
              {busy ? SHORT[bot.status] : "Idle"}
            </span>
            {bot.queued > 0 && (
              <span className="badge" title={`${bot.queued} queued`}>
                {bot.queued} queued
              </span>
            )}
          </span>
          {bot.preview ? <span className="bot-preview">{bot.preview}</span> : <span className="bot-preview empty-preview">No messages yet</span>}
        </span>
      </button>
      <button className="bot-delete" onClick={() => onDelete(bot)} title={`Delete ${bot.name}`} aria-label={`Delete ${bot.name}`}>
        <Trash2 size={14} strokeWidth={1.9} />
      </button>
    </div>
  );
});

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function Sidebar({
  selected,
  onSelect,
  onNewBot,
  onTogglePerf,
}: {
  selected: BotId | undefined;
  onSelect: (id: BotId) => void;
  onNewBot: () => void;
  onTogglePerf: () => void;
}) {
  const { bots, connection } = useSyncExternalStore(top.subscribe, top.getSnapshot);
  const seen = useSeen();
  const [deleting, setDeleting] = useState<BotSummary>();
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
        {connection !== "open" && (
        <span className={`conn c-${connection}`} title={host(serverUrl)}>
          <i />
          {connection === "connecting" ? "Connecting" : "Reconnecting"}
        </span>
        )}
        </span>
      </div>
      <div className="section-label">
        <span className="section-title">Bots</span>
        <button className="icon-btn add-bot" onClick={onNewBot} title="New bot" aria-label="New bot">
          <Plus size={16} strokeWidth={2} />
        </button>
      </div>
      <nav className="bots">
        {bots.map((bot, i) => {
          const isSelected = bot.id === selected;
          return (
            <BotItem
              key={bot.id}
              bot={bot}
              index={i}
              selected={isSelected}
              unread={!isSelected && bot.lastSeq > (seen[bot.id] ?? 0)}
              onSelect={onSelect}
              onDelete={setDeleting}
            />
          );
        })}
      </nav>
      {deleting && <DeleteBotDialog bot={deleting} onClose={() => setDeleting(undefined)} />}
      <div className="sidebar-foot">
        <button className="icon-btn" onClick={onTogglePerf} title="Performance overlay (Ctrl+Shift+P)" aria-label="Performance overlay">
          <Activity size={16} strokeWidth={1.8} />
          <span>Performance</span>
        </button>
      </div>
    </aside>
  );
}
