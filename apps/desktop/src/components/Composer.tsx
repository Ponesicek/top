/**
 * The composer is isolated from streaming: it subscribes only to "is the bot running", so typing
 * never waits on a transcript render.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ConversationSync } from "@top/client";
import { perf } from "../perf.ts";

const drafts = new Map<string, string>();

export const Composer = memo(function Composer({ sync, name }: { sync: ConversationSync; name: string }) {
  const key = String(sync.id);
  const [text, setText] = useState(() => drafts.get(key) ?? "");
  const ref = useRef<HTMLTextAreaElement>(null);
  const running = useSyncExternalStore(sync.subscribe, () => Boolean(sync.getSnapshot().live?.run));

  useEffect(() => {
    ref.current?.focus();
  }, [key]);

  // Grow with the text, up to a cap.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);

  const send = useCallback(
    (steer: boolean) => {
      const value = text.trim();
      if (!value) return;
      sync.send(value, running ? (steer ? "steer" : "followUp") : "followUp");
      setText("");
      drafts.delete(key);
    },
    [text, running, sync, key],
  );

  return (
    <div className="composer">
      <textarea
        ref={ref}
        value={text}
        rows={1}
        placeholder={running ? `${name} is working. Enter queues, Ctrl+Enter steers` : `Message ${name}`}
        onChange={(e) => {
          setText(e.target.value);
          drafts.set(key, e.target.value);
        }}
        onKeyDown={(e) => {
          perf.trackInput(e.nativeEvent);
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send(e.ctrlKey || e.metaKey);
          } else if (e.key === "Escape" && running) {
            void sync.abort().catch(() => {});
          }
        }}
      />
      <div className="composer-actions">
        {running && (
          <button className="ghost" disabled={!text.trim()} onClick={() => send(true)} title="Ctrl+Enter">
            Steer
          </button>
        )}
        <button className="primary" disabled={!text.trim()} onClick={() => send(false)}>
          {running ? "Queue" : "Send"}
        </button>
      </div>
    </div>
  );
});
