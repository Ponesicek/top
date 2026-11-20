import type { BotId } from "@top/client";
import { useCallback, useEffect, useState } from "react";
import { NewBotDialog } from "./components/BotDialogs.tsx";
import { SignInGate } from "./components/ChatGPT.tsx";
import { Composer } from "./components/Composer.tsx";
import { EditMenu } from "./components/EditMenu.tsx";
import { Empty, EmptyCard } from "./components/Empty.tsx";
import { FilesPanel } from "./components/files/FilesPanel.tsx";
import { FilesToggle, Header } from "./components/Header.tsx";
import { PerfHud } from "./components/PerfHud.tsx";
import { Settings } from "./components/Settings.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { Transcript } from "./components/Transcript.tsx";
import { UpdatePopup } from "./components/UpdatePopup.tsx";
import { Button } from "./components/ui/button.tsx";
import { TooltipProvider } from "./components/ui/tooltip.tsx";
import { readShowTools, saveShowTools } from "./display.ts";
import { toggleFiles, useBotFiles, usePanel, usePanelLayout } from "./files.ts";
import { cn } from "./lib/utils.ts";
import { applyScale, canScale, readScale, type Scale, stepScale } from "./scale.ts";
import { conversation, markSeen, sidebarOrder, top, useBot, useClient, useRoster } from "./top.ts";

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
  } catch {}
}

export function App() {
  const bots = useRoster();
  const [selected, setSelected] = useState<BotId | undefined>(() => {
    const saved = readSelected();
    return saved === undefined ? undefined : Number(saved);
  });
  const [hud, setHudState] = useState(readPerfHud);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [showTools, setShowToolsState] = useState(readShowTools);
  const setShowTools = useCallback((on: boolean) => {
    setShowToolsState(on);
    saveShowTools(on);
  }, []);
  const [scale, setScaleState] = useState<Scale>(readScale);
  const setScale = useCallback((next: Scale) => {
    setScaleState(next);
    applyScale(next);
  }, []);
  const [creating, setCreating] = useState(false);
  const ready = useClient((snapshot) => snapshot.ready);
  const offline = useClient((snapshot) => snapshot.connection !== "open");
  useEffect(() => {
    document.documentElement.toggleAttribute("data-offline", offline);
  }, [offline]);

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
    } catch {}
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        setHud((h) => !h);
      } else if (canScale && (e.ctrlKey || e.metaKey) && !e.altKey && ["=", "+", "-", "0"].includes(e.key)) {
        e.preventDefault();
        setScale(e.key === "0" ? 1 : stepScale(scale, e.key === "-" ? -1 : 1));
      } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "e") {
        e.preventDefault();
        toggleFiles();
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
      } else if (e.altKey && !e.shiftKey && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
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

  useEffect(() => {
    window.__topSelect = (i) => {
      const target = top.getSnapshot().bots[i];
      if (target) select(target.id);
    };
  }, [select]);

  const sync = bot ? conversation(bot.id) : undefined;
  const panel = usePanel();
  const layout = usePanelLayout();
  const hasFiles = useBotFiles(bot?.id) !== undefined;
  const filesOpen = panel.open && !settingsOpen && !!bot && hasFiles;
  const covered = filesOpen && layout.overlay;

  const summary = useBot(bot?.id);
  const seenId = summary?.id;
  const seenSeq = summary?.lastSeq;
  useEffect(() => {
    if (seenId !== undefined && seenSeq !== undefined && !settingsOpen) markSeen(seenId, seenSeq);
  }, [seenId, seenSeq, settingsOpen]);

  return (
    <TooltipProvider delay={500}>
      <div
        className={cn(
          "relative grid h-full grid-cols-[280px_minmax(0,1fr)] [--chat-min:340px] [--sidebar-width:280px] narrow:grid-cols-[72px_minmax(0,1fr)]",
          filesOpen && !layout.overlay && "grid-cols-[280px_minmax(var(--chat-min),1fr)_auto]",
        )}
      >
        {/* What the Files panel covers can't be reached with Tab behind it. */}
        <div className="contents" inert={covered && layout.width >= innerWidth}>
          <Sidebar selected={bot?.id} onSelect={select} onNewBot={openNewBot} settingsOpen={settingsOpen} onOpenSettings={openSettings} />
        </div>
        <main className="relative flex min-h-0 min-w-0 flex-col bg-background" inert={covered}>
          {!settingsOpen && !(bot && sync) && <div className="h-15 flex-none [-webkit-app-region:drag]" aria-hidden />}
          {settingsOpen ? (
            <Settings
              perfHud={hud}
              onPerfHudChange={setPerfHud}
              showTools={showTools}
              onShowToolsChange={setShowTools}
              scale={scale}
              onScaleChange={setScale}
            />
          ) : bot && sync ? (
            <>
              <Header sync={sync} name={bot.name} avatar={bot.avatar} filesOpen={filesOpen && !layout.overlay} />
              <div
                className="pointer-events-none relative z-2 h-0 after:absolute after:top-0 after:right-2.5 after:left-0 after:h-6 after:bg-linear-to-b after:from-background after:from-25% after:to-transparent"
                aria-hidden
              />
              <Transcript key={String(bot.id)} sync={sync} showTools={showTools} />
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
        {filesOpen && bot && <FilesPanel bot={bot.id} name={bot.name} layout={layout} />}
        {!settingsOpen && bot && <FilesToggle bot={bot.id} open={filesOpen} />}
        <NewBotDialog
          open={creating}
          onOpenChange={setCreating}
          onCreated={(id) => {
            setCreating(false);
            select(id);
          }}
        />
        {hud && <PerfHud />}
        {!settingsOpen && <UpdatePopup onOpenSettings={openSettings} />}
        <SignInGate />
        <EditMenu />
      </div>
    </TooltipProvider>
  );
}
