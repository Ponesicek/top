/**
 * The composer is isolated from the transcript: it subscribes only to "is the bot working", so typing
 * never waits on a transcript render.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { ArrowUp } from "lucide-react";
import type { ConversationSync } from "@top/client";
import { perf } from "../perf.ts";
import { isWorking } from "../rows.ts";
import { top } from "../top.ts";

const drafts = new Map<string, string>();

export const Composer = memo(function Composer({ sync, name }: { sync: ConversationSync; name: string }) {
  const key = String(sync.id);
  const [text, setText] = useState(() => drafts.get(key) ?? "");
  const ref = useRef<HTMLTextAreaElement>(null);
  const running = useSyncExternalStore(top.subscribe, () => isWorking(top.getSnapshot().bots.find((b) => b.id === sync.id)?.status));

  useEffect(() => {
    ref.current?.focus();
  }, [key]);

  // Grow with the text, up to a cap.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
    el.style.overflowY = el.scrollHeight > 240 ? "auto" : "hidden";
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

  const empty = !text.trim();
  return (
    <div className="composer-dock">
    <div className="composer-wrap">
      <div className="composer" onMouseDown={(e) => e.target === e.currentTarget && (e.preventDefault(), ref.current?.focus())}>
        <span className="compose-gutter" aria-hidden>
          ›
        </span>
        <textarea
          ref={ref}
          value={text}
          rows={1}
          placeholder={`Message ${name}…`}
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
        {/* Steer and Queue appear once there is something to send; empty, the composer stays calm. */}
        {running && !empty ? (
          <div className="composer-actions">
            <button className="ghost" onClick={() => send(true)} title="Steer: interrupt with this message (Ctrl+Enter)">
              Steer
            </button>
            <button className="primary" onClick={() => send(false)} title="Queue after the current task (Enter)">
              Queue
            </button>
          </div>
        ) : (
          <button className="send" disabled={empty} onClick={() => send(false)} title="Send (Enter) · Shift+Enter for a new line" aria-label="Send">
            <ArrowUp size={17} strokeWidth={1.7} />
          </button>
        )}
      </div>
      {/* Only the working state's keys need explaining (idle is the usual Enter / Shift+Enter). The line
          keeps its height either way, so the transcript doesn't jump when a bot starts or stops. */}
      <div className="composer-hint">{running ? "Enter queues · Ctrl+Enter steers · Esc stops" : ""}</div>
    </div>
    </div>
  );
});
