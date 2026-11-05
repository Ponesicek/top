import { memo, useSyncExternalStore } from "react";
import type { ConversationSync } from "@top/client";

export const Header = memo(function Header({ sync, name }: { sync: ConversationSync; name: string }) {
  const running = useSyncExternalStore(sync.subscribe, () => Boolean(sync.getSnapshot().live?.run));
  const status = useSyncExternalStore(sync.subscribe, () => sync.getSnapshot().status);
  return (
    <header className="header">
      <div className="title">
        <h1>{name}</h1>
        {status === "stale" && <span className="stale">Offline · showing last known state</span>}
      </div>
      {running && (
        <button className="stop" onClick={() => void sync.abort().catch(() => {})} title="Stop (Esc)">
          <span className="square" /> Stop
        </button>
      )}
    </header>
  );
});
