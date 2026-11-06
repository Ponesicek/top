import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { BotId } from "@top/client";
import { NewBotDialog } from "./components/BotDialogs.tsx";
import { Composer } from "./components/Composer.tsx";
import { Empty, EmptyCard } from "./components/Empty.tsx";
import { Header } from "./components/Header.tsx";
import { PerfHud } from "./components/PerfHud.tsx";
import { Settings } from "./components/Settings.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { Transcript } from "./components/Transcript.tsx";
import { Button } from "./components/ui/button.tsx";
import { TooltipProvider } from "./components/ui/tooltip.tsx";
import { conversation, markSeen, top, useBot } from "./top.ts";

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
  const roster = useSyncExternalStore(top.subscribe, () => top.getSnapshot().bots.map((b) => `${b.id}:${b.name}`).join("|"));
  const bots = useMemo(() => top.getSnapshot().bots, [roster]);
  const [selected, setSelected] = useState<BotId | undefined>(() => {
    const saved = readSelected();
    return saved === undefined ? undefined : Number(saved);
  });
  const [hud, setHudState] = useState(readPerfHud);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const ready = useSyncExternalStore(top.subscribe, () => top.getSnapshot().ready);

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
      } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === ",") {
        e.preventDefault();
        setSettingsOpen(true);
      } else if (e.key === "Escape" && settingsOpen) {
        e.preventDefault();
        setSettingsOpen(false);
      } else if ((e.ctrlKey || e.metaKey) && /^[1-9]$/.test(e.key)) {
        const target = top.getSnapshot().bots[Number(e.key) - 1];
        if (target) {
          e.preventDefault();
          select(target.id);
        }
      } else if (e.altKey && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
        const list = top.getSnapshot().bots;
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
  }, [bot?.id, select, setHud, settingsOpen]);

  // Expose a tiny driver for `pnpm bench`.
  useEffect(() => {
    (window as unknown as { __topSelect: (i: number) => void }).__topSelect = (i) => {
      const target = top.getSnapshot().bots[i];
      if (target) select(target.id);
    };
  }, [select]);

  const sync = bot ? conversation(bot.id) : undefined;

  // The open bot's newest entry counts as read; with settings open, no bot is open.
  const summary = useBot(bot?.id);
  useEffect(() => {
    if (summary && !settingsOpen) markSeen(summary.id, summary.lastSeq);
  }, [summary?.id, summary?.lastSeq, settingsOpen]);

  return (
    <TooltipProvider delay={500}>
    <div className="grid h-full grid-cols-[280px_1fr] narrow:grid-cols-[72px_1fr]">
      <Sidebar selected={bot?.id} onSelect={select} onNewBot={openNewBot} settingsOpen={settingsOpen} onOpenSettings={openSettings} />
      <main className="relative flex min-h-0 min-w-0 flex-col bg-background">
        {settingsOpen ? (
          <Settings perfHud={hud} onPerfHudChange={setPerfHud} />
        ) : bot && sync ? (
          <>
            <Header sync={sync} name={bot.name} />
            {/* A soft edge under the header, so text scrolling away fades instead of being sliced. */}
            <div className="pointer-events-none relative z-2 h-0 after:absolute after:top-0 after:right-2.5 after:left-0 after:h-6 after:bg-linear-to-b after:from-background after:from-25% after:to-transparent" aria-hidden />
            <Transcript key={String(bot.id)} sync={sync} name={bot.name} />
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
      <NewBotDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(id) => {
          setCreating(false);
          select(id);
        }}
      />
      {hud && <PerfHud />}
    </div>
    </TooltipProvider>
  );
}
