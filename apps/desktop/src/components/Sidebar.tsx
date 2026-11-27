import { ContextMenu } from "@base-ui/react/context-menu";
import type { BotId, BotSummary } from "@top/client";
import { ArrowDown, ArrowUp, Cpu, Pin, PinOff, Plus, Settings, Trash2 } from "lucide-react";
import { memo, type ReactNode, useCallback, useId, useRef, useState } from "react";
import { cn } from "../lib/utils.ts";
import { withRestOrder } from "../order.ts";
import { pin, reorderPins, serverUrl, sidebarGroups, top, unpin, useClient, usePins, useSeen } from "../top.ts";
import { Avatar } from "./Avatar.tsx";
import { BotModelDialog, DeleteBotDialog } from "./BotDialogs.tsx";
import { StatusDot } from "./StatusDot.tsx";
import { type Group, menuOpened, reordering, useSidebarReorder } from "./sidebarReorder.ts";
import { UpdateButton } from "./UpdateButton.tsx";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
import { Tooltip } from "./ui/tooltip.tsx";

const SHORT: Record<BotSummary["status"], string> = { idle: "", thinking: "Thinking", tool: "Running", retrying: "Retrying", failed: "Failed" };

export function statusLabel(bot: BotSummary): string {
  switch (bot.status) {
    case "idle":
      return bot.asks ? "Waiting for your answer" : "Idle";
    case "thinking":
      return bot.searching ? "Searching the web" : "Thinking";
    case "tool":
      return `Running ${bot.tool ?? "a tool"}`;
    case "retrying":
      return "Retrying";
    case "failed":
      return "Needs attention";
  }
}

function wakeLabel(at: number): string {
  const when = new Date(at);
  const now = new Date();
  const time = when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (when.toDateString() === now.toDateString()) return `Wakes ${time}`;
  if (at - now.getTime() < 6 * 24 * 60 * 60 * 1000) return `Wakes ${when.toLocaleDateString([], { weekday: "short" })} ${time}`;
  return `Wakes ${when.toLocaleDateString([], { month: "short", day: "numeric" })}`;
}

const MENU_POPUP =
  "min-w-44 origin-(--transform-origin) rounded-xl bg-popover p-1 text-foreground shadow-popover outline-none transition duration-100 data-ending-style:scale-98 data-ending-style:opacity-0 data-starting-style:scale-98 data-starting-style:opacity-0 data-instant:duration-0 [-webkit-app-region:no-drag]";
const MENU_ITEM =
  "flex cursor-default items-center gap-2.5 rounded-lg px-2.5 py-1.75 text-small leading-none font-label outline-none select-none data-highlighted:bg-foreground/7 [&_svg]:text-muted-foreground";

type Reorder = { readonly group: Group; readonly up: boolean; readonly down: boolean; readonly onMove: (id: BotId, by: -1 | 1) => void };

function BotMenu({
  bot,
  pinned,
  reorder,
  onDelete,
  className,
  children,
}: {
  bot: BotSummary;
  pinned: boolean;
  reorder: Reorder;
  onDelete: (bot: BotSummary) => void;
  className?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  return (
    <>
      <ContextMenu.Root
        open={open}
        onOpenChange={(next) => {
          if (next && reordering()) return;
          if (next) menuOpened();
          setOpen(next);
        }}
      >
        <ContextMenu.Trigger className={className} data-reorder={reorder.group} data-bot={bot.id}>
          {children}
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Positioner className="z-40" collisionPadding={8}>
            <ContextMenu.Popup className={MENU_POPUP} onKeyDown={(e) => e.stopPropagation()}>
              <ContextMenu.Item className={MENU_ITEM} onClick={() => (pinned ? unpin(bot.id) : pin(bot.id))}>
                {pinned ? <PinOff size={15} strokeWidth={1.9} /> : <Pin size={15} strokeWidth={1.9} />}
                {pinned ? "Unpin" : "Pin to top"}
              </ContextMenu.Item>
              <ContextMenu.Item className={cn(MENU_ITEM, "data-disabled:opacity-45")} disabled={!reorder.up} onClick={() => reorder.onMove(bot.id, -1)}>
                <ArrowUp size={15} strokeWidth={1.9} />
                Move up
                <kbd className="ml-auto pl-3 font-sans text-micro text-muted-foreground">Alt+Shift+↑</kbd>
              </ContextMenu.Item>
              <ContextMenu.Item className={cn(MENU_ITEM, "data-disabled:opacity-45")} disabled={!reorder.down} onClick={() => reorder.onMove(bot.id, 1)}>
                <ArrowDown size={15} strokeWidth={1.9} />
                Move down
                <kbd className="ml-auto pl-3 font-sans text-micro text-muted-foreground">Alt+Shift+↓</kbd>
              </ContextMenu.Item>
              <ContextMenu.Item className={MENU_ITEM} onClick={() => setModelOpen(true)}>
                <Cpu size={15} strokeWidth={1.9} />
                Runs on…
              </ContextMenu.Item>
              <ContextMenu.Separator className="mx-1.5 my-1 h-px bg-border" />
              <ContextMenu.Item
                className={cn(MENU_ITEM, "text-destructive-foreground data-highlighted:bg-destructive-surface [&_svg]:text-current")}
                onClick={() => onDelete(bot)}
              >
                <Trash2 size={15} strokeWidth={1.9} />
                Delete…
              </ContextMenu.Item>
            </ContextMenu.Popup>
          </ContextMenu.Positioner>
        </ContextMenu.Portal>
      </ContextMenu.Root>
      <BotModelDialog bot={bot} open={modelOpen} onOpenChange={setModelOpen} onClosed={() => {}} />
    </>
  );
}

type ItemProps = {
  bot: BotSummary;
  selected: boolean;
  unread: boolean;
  index: number;
  reorder: Reorder;
  onSelect: (id: BotId) => void;
  onDelete: (bot: BotSummary) => void;
};

const shortcutFor = (index: number) => (index < 9 ? ` (Ctrl+${index + 1})` : "");

function AskMark({ className }: { className?: string }) {
  return (
    <span className={cn("absolute -top-0.5 -right-0.5 grid size-3.75 place-items-center rounded-full bg-(--avatar-ring)", className)} aria-hidden>
      <i className="size-1.75 rounded-full bg-warning ring-2 ring-warning-surface" />
    </span>
  );
}

const PinnedTile = memo(function PinnedTile({ bot, selected, unread, index, reorder, onSelect, onDelete }: ItemProps) {
  const busy = bot.status !== "idle";
  const asking = !busy && !!bot.asks;
  const fresh = unread && !busy && !asking;
  const mark = (busy && bot.status !== "failed") || fresh;
  const status = fresh ? "Idle · new messages" : statusLabel(bot);
  return (
    <BotMenu bot={bot} pinned reorder={reorder} onDelete={onDelete} className="flex min-w-0">
      <button
        type="button"
        className={cn(
          "flex min-w-0 flex-1 flex-col items-center gap-1.5 rounded-2xl px-1 pt-2.5 pb-2 transition duration-90 hover:bg-foreground/5 narrow:rounded-xl narrow:py-2.25",
          selected
            ? "bg-sidebar-row-selected shadow-row-selected [--avatar-ring:var(--color-sidebar-row-selected)] hover:bg-sidebar-row-selected"
            : "[--avatar-ring:var(--color-sidebar)]",
        )}
        onClick={() => onSelect(bot.id)}
        title={`${bot.name}${shortcutFor(index)} · ${status}${bot.description ? `\n${bot.description}` : ""}`}
        aria-current={selected || undefined}
      >
        <span className="relative flex">
          <Avatar name={bot.name} avatar={bot.avatar} status={bot.status} size="lg" className="size-12 narrow:size-9" />
          {mark ? (
            <span className="absolute -top-0.5 -right-0.5 grid size-3.75 place-items-center rounded-full bg-(--avatar-ring)" aria-hidden>
              <StatusDot status={bot.status} fresh={fresh} />
            </span>
          ) : (
            asking && <AskMark />
          )}
        </span>
        <span
          className={cn(
            "line-clamp-2 w-full text-center text-small leading-tight tracking-name break-words narrow:hidden",
            fresh ? "font-heading text-foreground" : "font-label text-secondary-foreground",
            selected && "text-foreground",
          )}
        >
          {bot.name}
        </span>
      </button>
    </BotMenu>
  );
});

const BotItem = memo(function BotItem({ bot, selected, unread, index, reorder, onSelect, onDelete }: ItemProps) {
  const busy = bot.status !== "idle";
  const fresh = unread && !busy;
  const failed = bot.status === "failed";
  const shortcut = shortcutFor(index);
  return (
    <BotMenu bot={bot} pinned={false} reorder={reorder} onDelete={onDelete} className="group/bot relative flex flex-col">
      <button
        type="button"
        className={cn(
          "flex min-w-0 items-center gap-3 rounded-xl px-2.5 py-2.25 text-left transition duration-90 hover:bg-foreground/5 narrow:justify-center",
          selected
            ? "bg-sidebar-row-selected shadow-row-selected [--avatar-ring:var(--color-sidebar-row-selected)] hover:bg-sidebar-row-selected"
            : "[--avatar-ring:var(--color-sidebar)]",
        )}
        onClick={() => onSelect(bot.id)}
        title={`${bot.name}${shortcut}${bot.asks ? " · Waiting for your answer" : ""}${bot.description ? `\n${bot.description}` : ""}`}
        aria-current={selected || undefined}
      >
        <span className="relative flex">
          <Avatar name={bot.name} avatar={bot.avatar} status={bot.status} />
          {!!bot.asks && <AskMark className="hidden narrow:grid" />}
        </span>
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
              {busy ? (bot.searching ? "Searching" : SHORT[bot.status]) : "Idle"}
            </span>
            {bot.queued > 0 && (
              <Badge className="group-hover/bot:invisible group-has-[[data-delete]:focus-visible]/bot:invisible" title={`${bot.queued} queued`}>
                {bot.queued} queued
              </Badge>
            )}
            {!!bot.asks && (
              <Badge
                variant="warning"
                className="group-hover/bot:invisible group-has-[[data-delete]:focus-visible]/bot:invisible"
                title={`${bot.asks} request${bot.asks === 1 ? "" : "s"} waiting for your answer`}
              >
                Needs you
              </Badge>
            )}
            {!!bot.background && (
              <Badge
                className="group-hover/bot:invisible group-has-[[data-delete]:focus-visible]/bot:invisible"
                title={`${bot.background} tool call${bot.background === 1 ? "" : "s"} still running in the background`}
              >
                {bot.background} running
              </Badge>
            )}
            {bot.wakeAt !== undefined && (
              <Badge
                className="group-hover/bot:invisible group-has-[[data-delete]:focus-visible]/bot:invisible"
                title={`Wakes up ${new Date(bot.wakeAt).toLocaleString()}`}
              >
                {wakeLabel(bot.wakeAt)}
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
    </BotMenu>
  );
});

/** Stable per group and position, so a bot's row only re-renders when it can move another way. */
function useReorderProps(onMove: Reorder["onMove"]) {
  const cache = useRef(new Map<string, Reorder>());
  const latest = useRef(onMove);
  latest.current = onMove;
  return (group: Group, up: boolean, down: boolean): Reorder => {
    const key = `${group}${up}${down}`;
    let props = cache.current.get(key);
    if (!props) {
      props = { group, up, down, onMove: (id, by) => latest.current(id, by) };
      cache.current.set(key, props);
    }
    return props;
  };
}

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
  const bots = useClient((snapshot) => snapshot.bots);
  const pins = usePins();
  const groups = sidebarGroups(bots, pins);
  const byId = new Map(bots.map((b) => [b.id, b]));
  const reorder = useSidebarReorder({
    groups: { pinned: groups.pinned.map((b) => b.id), rest: groups.rest.map((b) => b.id) },
    nameOf: (id) => byId.get(id)?.name ?? "Bot",
    onCommit: (group, ids) => {
      if (group === "pinned") return reorderPins(ids);
      const now = top.getSnapshot().bots.map((b) => b.id);
      void top.setBotOrder(withRestOrder(now, pins, ids)).catch(() => {});
    },
  });
  const hintId = useId();
  const reorderProps = useReorderProps(reorder.step);
  const pinned = reorder.shown("pinned").flatMap((id) => byId.get(id) ?? []);
  const rest = reorder.shown("rest").flatMap((id) => byId.get(id) ?? []);
  const item = (Item: typeof BotItem, bot: BotSummary, index: number, group: Group, place: number, size: number) => {
    const isSelected = !settingsOpen && bot.id === selected;
    return (
      <Item
        key={bot.id}
        bot={bot}
        index={index}
        reorder={reorderProps(group, place > 0, place < size - 1)}
        selected={isSelected}
        unread={!isSelected && bot.lastSeq > (seen[bot.id] ?? 0)}
        onSelect={onSelect}
        onDelete={askDelete}
      />
    );
  };
  const connection = useClient((snapshot) => snapshot.connection);
  const connecting = connection === "connecting" ? "Connecting" : "Reconnecting";
  const seen = useSeen();
  const [deleting, setDeleting] = useState<BotSummary>();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const askDelete = useCallback((bot: BotSummary) => {
    setDeleting(bot);
    setDeleteOpen(true);
  }, []);
  return (
    <aside className="flex min-w-0 flex-col border-r bg-sidebar">
      <nav
        ref={reorder.navRef}
        className="bots flex flex-1 flex-col gap-1 overflow-y-auto px-2.5 pt-2.5 pb-2.5 mac-window:pt-11"
        aria-label="Bots"
        aria-describedby={hintId}
        onPointerDown={reorder.onPointerDown}
        onKeyDown={reorder.onKeyDown}
        onDragStart={(e) => e.preventDefault()}
      >
        {pinned.length > 0 && (
          <div className="grid grid-cols-3 gap-1 narrow:grid-cols-1">{pinned.map((bot, i) => item(PinnedTile, bot, i, "pinned", i, pinned.length))}</div>
        )}
        {pinned.length > 0 && rest.length > 0 && <div className="mx-2 my-1.5 hidden h-px bg-border narrow:block" aria-hidden />}
        {rest.map((bot, i) => item(BotItem, bot, pinned.length + i, "rest", i, rest.length))}
      </nav>
      <span id={hintId} hidden>
        Drag a bot, or press Alt+Shift+Up or Down, to move it.
      </span>
      <div className="sr-only" aria-live="polite" role="status">
        {reorder.announcement}
      </div>
      <DeleteBotDialog bot={deleting} open={deleteOpen} onOpenChange={setDeleteOpen} onClosed={() => setDeleting(undefined)} />
      <div className="relative flex flex-none items-center gap-2 px-3 pt-2 pb-3 narrow:flex-col-reverse narrow:px-0">
        <Tooltip content="Settings (Ctrl+,)" side="right">
          <Button
            variant="ghost"
            size="xs"
            className={cn("font-medium text-secondary-foreground narrow:size-11", settingsOpen && "bg-foreground/7 text-foreground")}
            onClick={onOpenSettings}
            aria-label="Settings"
            aria-current={settingsOpen ? "page" : undefined}
          >
            <Settings size={16} strokeWidth={1.8} />
            <span className={cn("narrow:hidden", connection !== "open" && "hidden")}>Settings</span>
          </Button>
        </Tooltip>
        {connection !== "open" && (
          <Badge variant="warning" size="lg" className="min-w-0 shrink narrow:hidden" title={`${connecting} to ${host(serverUrl)}`}>
            <i className="size-1.5 flex-none animate-blink rounded-full bg-current" />
            <span className="truncate">{connecting}</span>
          </Badge>
        )}
        <span className="ml-auto flex flex-none items-center gap-1.5 narrow:ml-0 narrow:flex-col-reverse">
          <UpdateButton onOpenSettings={onOpenSettings} />
          <Tooltip content="New bot" side="right">
            <Button
              variant="outline"
              size="icon"
              className="size-8 text-secondary-foreground hover:text-foreground narrow:size-11"
              onClick={onNewBot}
              aria-label="New bot"
            >
              <Plus size={17} strokeWidth={1.9} />
            </Button>
          </Tooltip>
        </span>
      </div>
    </aside>
  );
}
