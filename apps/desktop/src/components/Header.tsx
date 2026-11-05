import { memo, useSyncExternalStore } from "react";
import type { ConversationSync } from "@top/client";
import { isWorking } from "../rows.ts";
import { useBot } from "../top.ts";

export const Header = memo(function Header({ sync, name }: { sync: ConversationSync; name: string }) {
  const working = isWorking(useBot(sync.id)?.status);
  const status = useSyncExternalStore(sync.subscribe, () => sync.getSnapshot().status);
  return (
    <header className="header">
      <div className="title">
        <h1>{name}</h1>
        {status === "stale" && <span className="stale">Offline · showing last known state</span>}
      </div>
      {working && (
        <button className="stop" onClick={() => void sync.abort().catch(() => {})} title="Stop (Esc)">
          <span className="square" /> Stop
        </button>
      )}
    </header>
  );
});
