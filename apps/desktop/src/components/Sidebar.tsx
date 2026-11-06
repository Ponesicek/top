import type { BotId, BotSummary } from "@top/client";
import { Plus, Settings, Trash2 } from "lucide-react";
import { memo, useCallback, useState, useSyncExternalStore } from "react";
import { cn } from "../lib/utils.ts";
import { serverUrl, top, useSeen } from "../top.ts";
import { Avatar } from "./Avatar.tsx";
import { DeleteBotDialog } from "./BotDialogs.tsx";
import { StatusDot } from "./StatusDot.tsx";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
import { Tooltip } from "./ui/tooltip.tsx";

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
  const failed = bot.status === "failed";
  const shortcut = index < 9 ? ` (Ctrl+${index + 1})` : "";
  return (
    // Delete shows on hover (or keyboard focus), in place of the status beside the name.
    <div className="group/bot relative flex flex-col">
      <button
        type="button"
        className={cn(
          "flex min-w-0 items-center gap-3 rounded-xl px-2.5 py-2.25 text-left transition duration-90 hover:bg-foreground/5 narrow:justify-center",
          selected
            ? "bg-sidebar-row-selected shadow-row-selected [--avatar-ring:var(--color-sidebar-row-selected)] hover:bg-sidebar-row-selected"
            : "[--avatar-ring:var(--color-sidebar)]",
        )}
        onClick={() => onSelect(bot.id)}
        title={bot.description ? `${bot.name}${shortcut}\n${bot.description}` : `${bot.name}${shortcut}`}
        aria-current={selected || undefined}
      >
        <Avatar name={bot.name} status={bot.status} />
        <span className="flex min-w-0 flex-1 flex-col gap-px narrow:hidden">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className={cn("min-w-0 flex-1 truncate text-body leading-snug tracking-name", fresh ? "font-heading" : "font-label")}>{bot.name}</span>
            <span
              className={cn(
                "inline-flex flex-none items-center gap-1.5 text-meta leading-none font-label group-hover/bot:invisible group-has-[[data-delete]:focus-visible]/bot:invisible",
                failed ? "rounded-full bg-destructive-surface py-0.75 pr-1.75 pl-1.5 text-destructive-foreground" : "text-muted-foreground",
              )}
              title={fresh ? "Idle · new messages" : statusLabel(bot)}
            >
              <StatusDot status={bot.status} fresh={fresh} />
              {busy ? SHORT[bot.status] : "Idle"}
            </span>
            {bot.queued > 0 && (
              <Badge className="group-hover/bot:invisible group-has-[[data-delete]:focus-visible]/bot:invisible" title={`${bot.queued} queued`}>
                {bot.queued} queued
              </Badge>
            )}
          </span>
          <span className={cn("truncate text-small leading-snug", fresh && bot.preview ? "text-secondary-foreground" : "text-muted-foreground")}>
            {bot.preview || "No messages yet"}
          </span>
        </span>
      </button>
      <Tooltip content={`Delete ${bot.name}`} side="right">
        <Button
          data-delete
          variant="ghost-destructive"
          size="icon-row"
          className="absolute top-2.25 right-2 opacity-0 group-hover/bot:opacity-100 focus-visible:opacity-100 narrow:hidden"
          onClick={() => onDelete(bot)}
          aria-label={`Delete ${bot.name}`}
        >
          <Trash2 size={14} strokeWidth={1.9} />
        </Button>
      </Tooltip>
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
  settingsOpen,
  onOpenSettings,
}: {
  selected: BotId | undefined;
  onSelect: (id: BotId) => void;
  onNewBot: () => void;
  settingsOpen: boolean;
  onOpenSettings: () => void;
}) {
  const { bots, connection } = useSyncExternalStore(top.subscribe, top.getSnapshot);
  const seen = useSeen();
  const [deleting, setDeleting] = useState<BotSummary>();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const askDelete = useCallback((bot: BotSummary) => {
    setDeleting(bot);
    setDeleteOpen(true);
  }, []);
  return (
    <aside className="flex min-w-0 flex-col border-r bg-sidebar [-webkit-app-region:drag] [&_button]:[-webkit-app-region:no-drag]">
      <div className="flex h-15 flex-none items-center justify-between pr-4 pl-4.5 narrow:justify-center narrow:p-0">
        <span
          className="inline-flex items-center gap-2.25 text-[17px] leading-none font-semibold tracking-[-0.03em] narrow:gap-0 narrow:text-[0px]"
          role="img"
          aria-label="Top"
        >
          {/* The mark is a shell prompt, "›_": the app is named after the Unix `top`. */}
          <span
            className="relative size-6 rounded-md bg-linear-145/srgb from-[#ff9a5c] to-[#ec4d16] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.2)]"
            aria-hidden
          >
            <svg
              className="block"
              aria-hidden="true"
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#fff"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M7 8l4 4-4 4" />
              <path d="M13 16h4.5" />
            </svg>
          </span>
          top
        </span>
        {connection !== "open" && (
          <Badge variant="warning" size="lg" className="narrow:hidden" title={host(serverUrl)}>
            <i className="size-1.5 animate-blink rounded-full bg-current" />
            {connection === "connecting" ? "Connecting" : "Reconnecting"}
          </Badge>
        )}
      </div>
      <div className="flex items-center justify-between px-5 pt-4 pb-2.5 text-micro font-semibold text-secondary-foreground narrow:hidden">
        Bots
        <Tooltip content="New bot">
          <Button variant="ghost" size="icon-xs" className="-m-1.5" onClick={onNewBot} aria-label="New bot">
            <Plus size={16} strokeWidth={2} />
          </Button>
        </Tooltip>
      </div>
      <nav className="bots flex flex-1 flex-col gap-1 overflow-y-auto px-2.5 pt-0.5 pb-2.5">
        {bots.map((bot, i) => {
          // While settings fill the main area, no bot is open.
          const isSelected = !settingsOpen && bot.id === selected;
          return (
            <BotItem
              key={bot.id}
              bot={bot}
              index={i}
              selected={isSelected}
              unread={!isSelected && bot.lastSeq > (seen[bot.id] ?? 0)}
              onSelect={onSelect}
              onDelete={askDelete}
            />
          );
        })}
      </nav>
      {/* Always mounted: a dialog that mounts already open has no closed state to animate in from. */}
      <DeleteBotDialog bot={deleting} open={deleteOpen} onOpenChange={setDeleteOpen} onClosed={() => setDeleting(undefined)} />
      <div className="flex-none px-3 pt-2 pb-3">
        <Tooltip content="Settings (Ctrl+,)" side="right">
          <Button
            variant="ghost"
            size="xs"
            className={cn("font-medium text-secondary-foreground", settingsOpen && "bg-foreground/7 text-foreground")}
            onClick={onOpenSettings}
            aria-label="Settings"
            aria-current={settingsOpen ? "page" : undefined}
          >
            <Settings size={16} strokeWidth={1.8} />
            <span className="narrow:hidden">Settings</span>
          </Button>
        </Tooltip>
      </div>
    </aside>
  );
}
