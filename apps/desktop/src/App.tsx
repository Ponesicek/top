import type { BotId } from "@top/client";
import { useCallback, useEffect, useState } from "react";
import { type AvatarStyle, applyAvatarStyle, readAvatarStyle } from "./avatarStyle.ts";
import { type ChatStyle, readChatStyle, readShowTools, saveChatStyle, saveShowTools } from "./chatStyle.ts";
import { NewBotDialog } from "./components/BotDialogs.tsx";
import { SignInGate } from "./components/ChatGPT.tsx";
import { Composer } from "./components/Composer.tsx";
import { EditMenu } from "./components/EditMenu.tsx";
import { Empty, EmptyCard } from "./components/Empty.tsx";
import { FilesPanel } from "./components/files/FilesPanel.tsx";
import { Header } from "./components/Header.tsx";
import { PerfHud } from "./components/PerfHud.tsx";
import { Settings } from "./components/Settings.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { Transcript } from "./components/Transcript.tsx";
import { UpdatePopup } from "./components/UpdatePopup.tsx";
import { Button } from "./components/ui/button.tsx";
import { TooltipProvider } from "./components/ui/tooltip.tsx";
import { togglePanel, useBotFiles, usePanel } from "./files.ts";
import { cn } from "./lib/utils.ts";
import { applyScale, canScale, readScale, type Scale, stepScale } from "./scale.ts";
import { conversation, markSeen, sidebarOrder, top, useBot, useClient, useRoster } from "./top.ts";

// For `pnpm bench` and `pnpm screenshot` (electron/bench-driver.js): select the i-th bot.
declare global {
  interface Window {
    __topSelect?: (i: number) => void;
  }
}

function readSelected(): string | undefined {
  try {
    return localStorage.getItem("top.selected") ?? undefined;
  } catch {
    return undefined;
  }
}

/** The overlay stays on across restarts; `?perf` turns it on regardless. */
function readPerfHud(): boolean {
  if (new URLSearchParams(location.search).has("perf")) return true;
  try {
    return localStorage.getItem("top.perfHud") === "1";
  } catch {
    return false;
  }
}

function savePerfHud(on: boolean) {
  try {
    localStorage.setItem("top.perfHud", on ? "1" : "0");
  } catch {
    // ignore
  }
}

export function App() {
  // Re-render only when the roster changes, not on every status/preview update (those are the sidebar's).
  const bots = useRoster();
  const [selected, setSelected] = useState<BotId | undefined>(() => {
    const saved = readSelected();
    return saved === undefined ? undefined : Number(saved);
  });
  const [hud, setHudState] = useState(readPerfHud);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [chatStyle, setChatStyleState] = useState<ChatStyle>(readChatStyle);
  const setChatStyle = useCallback((style: ChatStyle) => {
    setChatStyleState(style);
    saveChatStyle(style);
  }, []);
  const [showTools, setShowToolsState] = useState(readShowTools);
  const setShowTools = useCallback((on: boolean) => {
    setShowToolsState(on);
    saveShowTools(on);
  }, []);
  const [avatarStyle, setAvatarStyleState] = useState<AvatarStyle>(readAvatarStyle);
  const setAvatarStyle = useCallback((style: AvatarStyle) => {
    setAvatarStyleState(style);
    applyAvatarStyle(style);
  }, []);
  const [scale, setScaleState] = useState<Scale>(readScale);
  const setScale = useCallback((next: Scale) => {
    setScaleState(next);
    applyScale(next);
  }, []);
  const [creating, setCreating] = useState(false);
  const ready = useClient((snapshot) => snapshot.ready);

  const setHud = useCallback((update: (on: boolean) => boolean) => {
    setHudState((h) => {
      const next = update(h);
      savePerfHud(next);
      return next;
    });
  }, []);
  const setPerfHud = useCallback((on: boolean) => setHud(() => on), [setHud]);
  const openSettings = useCallback(() => setSettingsOpen(true), []);
  const openNewBot = useCallback(() => setCreating(true), []);
  const bot = bots.find((b) => String(b.id) === String(selected)) ?? bots[0];

  const select = useCallback((id: BotId) => {
    setSelected(id);
    setSettingsOpen(false);
    try {
      localStorage.setItem("top.selected", String(id));
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        setHud((h) => !h);
      } else if (canScale && (e.ctrlKey || e.metaKey) && !e.altKey && ["=", "+", "-", "0"].includes(e.key)) {
        // Interface size, as in a browser (the window menu that did this is gone on Windows/Linux).
        e.preventDefault();
        setScale(e.key === "0" ? 1 : stepScale(scale, e.key === "-" ? -1 : 1));
      } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "e") {
        e.preventDefault();
        togglePanel();
      } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === ",") {
        e.preventDefault();
        setSettingsOpen(true);
      } else if (e.key === "Escape" && settingsOpen) {
        e.preventDefault();
        setSettingsOpen(false);
      } else if ((e.ctrlKey || e.metaKey) && /^[1-9]$/.test(e.key)) {
        const target = sidebarOrder()[Number(e.key) - 1];
        if (target) {
          e.preventDefault();
          select(target.id);
        }
      } else if (e.altKey && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
        const list = sidebarOrder();
        const i = list.findIndex((b) => String(b.id) === String(bot?.id));
        const next = list[(i + (e.key === "ArrowDown" ? 1 : list.length - 1)) % list.length];
        if (next) {
          e.preventDefault();
          select(next.id);
        }
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [bot?.id, select, setHud, settingsOpen, scale, setScale]);

  // Expose a tiny driver for `pnpm bench`.
  useEffect(() => {
    window.__topSelect = (i) => {
      const target = top.getSnapshot().bots[i];
      if (target) select(target.id);
    };
  }, [select]);

  const sync = bot ? conversation(bot.id) : undefined;
  const panel = usePanel();
  // The panel is there when it's open, a bot is open, and the daemon gives bots files.
  const hasFiles = useBotFiles(bot?.id) !== undefined;
  const filesOpen = panel.open && !settingsOpen && !!bot && hasFiles;

  // The open bot's newest entry counts as read; with settings open, no bot is open.
  const summary = useBot(bot?.id);
  const seenId = summary?.id;
  const seenSeq = summary?.lastSeq;
  useEffect(() => {
    if (seenId !== undefined && seenSeq !== undefined && !settingsOpen) markSeen(seenId, seenSeq);
  }, [seenId, seenSeq, settingsOpen]);

  return (
    <TooltipProvider delay={500}>
      <div className={cn("grid h-full grid-cols-[280px_1fr] narrow:grid-cols-[72px_1fr]", filesOpen && "grid-cols-[280px_1fr_auto]")}>
        <Sidebar selected={bot?.id} onSelect={select} onNewBot={openNewBot} settingsOpen={settingsOpen} onOpenSettings={openSettings} />
        <main className="relative flex min-h-0 min-w-0 flex-col bg-background">
          {/* The sidebar doesn't drag the window, so without a header the top of this column does. */}
          {!settingsOpen && !(bot && sync) && <div className="h-15 flex-none [-webkit-app-region:drag]" aria-hidden />}
          {settingsOpen ? (
            <Settings
              perfHud={hud}
              onPerfHudChange={setPerfHud}
              chatStyle={chatStyle}
              onChatStyleChange={setChatStyle}
              showTools={showTools}
              onShowToolsChange={setShowTools}
              avatarStyle={avatarStyle}
              onAvatarStyleChange={setAvatarStyle}
              scale={scale}
              onScaleChange={setScale}
            />
          ) : bot && sync ? (
            <>
              <Header sync={sync} name={bot.name} avatar={bot.avatar} filesOpen={filesOpen} />
              {/* A soft edge under the header, so text scrolling away fades instead of being sliced. */}
              <div
                className="pointer-events-none relative z-2 h-0 after:absolute after:top-0 after:right-2.5 after:left-0 after:h-6 after:bg-linear-to-b after:from-background after:from-25% after:to-transparent"
                aria-hidden
              />
              <Transcript key={String(bot.id)} sync={sync} style={chatStyle} showTools={showTools} />
              <Composer key={`c${bot.id}`} sync={sync} name={bot.name} />
            </>
          ) : ready ? (
            <Empty>
              <EmptyCard title="No bots yet" action={<Button onClick={openNewBot}>New bot</Button>}>
                Make one to start a conversation.
              </EmptyCard>
            </Empty>
          ) : (
            <Empty>Waiting for the Top daemon…</Empty>
          )}
        </main>
        {filesOpen && bot && <FilesPanel bot={bot.id} name={bot.name} />}
        <NewBotDialog
          open={creating}
          onOpenChange={setCreating}
          onCreated={(id) => {
            setCreating(false);
            select(id);
          }}
        />
        {hud && <PerfHud />}
        {/* Settings has its own Updates section. */}
        {!settingsOpen && <UpdatePopup onOpenSettings={openSettings} />}
        <SignInGate />
        <EditMenu />
      </div>
    </TooltipProvider>
  );
}
