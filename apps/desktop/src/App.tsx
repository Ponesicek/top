import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { BotId } from "@top/client";
import { Composer } from "./components/Composer.tsx";
import { Header } from "./components/Header.tsx";
import { PerfHud } from "./components/PerfHud.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { Transcript } from "./components/Transcript.tsx";
import { conversation, markSeen, top, useBot } from "./top.ts";

function readSelected(): string | undefined {
  try {
    return localStorage.getItem("top.selected") ?? undefined;
  } catch {
    return undefined;
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
  const [hud, setHud] = useState(() => new URLSearchParams(location.search).has("perf"));

  const togglePerf = useCallback(() => setHud((h) => !h), []);
  const bot = bots.find((b) => String(b.id) === String(selected)) ?? bots[0];

  const select = useCallback((id: BotId) => {
    setSelected(id);
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
  }, [bot?.id, select]);

  // Expose a tiny driver for `pnpm bench`.
  useEffect(() => {
    (window as unknown as { __topSelect: (i: number) => void }).__topSelect = (i) => {
      const target = top.getSnapshot().bots[i];
      if (target) select(target.id);
    };
  }, [select]);

  const sync = bot ? conversation(bot.id) : undefined;

  // The open bot's newest entry counts as read.
  const summary = useBot(bot?.id);
  useEffect(() => {
    if (summary) markSeen(summary.id, summary.lastSeq);
  }, [summary?.id, summary?.lastSeq]);

  return (
    <div className="app">
      <Sidebar selected={bot?.id} onSelect={select} onTogglePerf={togglePerf} />
      <main className="main">
        {bot && sync ? (
          <>
            <Header sync={sync} name={bot.name} />
            <div className="top-fade" aria-hidden />
            <Transcript key={String(bot.id)} sync={sync} name={bot.name} />
            <Composer key={`c${bot.id}`} sync={sync} name={bot.name} />
          </>
        ) : (
          <div className="empty">Waiting for the Top daemon…</div>
        )}
      </main>
      {hud && <PerfHud />}
    </div>
  );
}
