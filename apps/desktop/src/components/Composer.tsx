/**
 * The composer is isolated from the transcript: it subscribes only to "is the bot working", so typing
 * never waits on a transcript render. Its buttons are a memoized child that re-renders only when
 * "empty" or "working" flips, not on every keystroke.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { ArrowUp, Square } from "lucide-react";
import type { ConversationSync } from "@top/client";
import { perf } from "../perf.ts";
import { isWorking } from "../rows.ts";
import { top } from "../top.ts";
import { Button } from "./ui/button.tsx";
import { Tooltip } from "./ui/tooltip.tsx";

const drafts = new Map<string, string>();

const Actions = memo(function Actions({ empty, running, onSend, onStop }: { empty: boolean; running: boolean; onSend: (steer: boolean) => void; onStop: () => void }) {
  // Steer and Queue appear once there is something to send; empty, the composer stays calm.
  if (running && !empty)
    return (
      <div className="flex flex-none gap-1.5">
        <Tooltip content="Steer: interrupt with this message (Ctrl+Enter)">
          <Button variant="outline" onClick={() => onSend(true)}>
            Steer
          </Button>
        </Tooltip>
        <Tooltip content="Queue after the current task (Enter)">
          <Button onClick={() => onSend(false)}>Queue</Button>
        </Tooltip>
      </div>
    );
  // While a bot works, the send button is Stop.
  if (running)
    return (
      <Tooltip content="Stop (Esc)">
        <Button variant="stop" size="icon" onClick={onStop} aria-label="Stop">
          <Square size={12} fill="currentColor" strokeWidth={0} />
        </Button>
      </Tooltip>
    );
  return (
    <Tooltip content="Send (Enter) · Shift+Enter for a new line">
      <Button size="icon" className="disabled:bg-foreground/8" disabled={empty} onClick={() => onSend(false)} aria-label="Send">
        <ArrowUp size={17} strokeWidth={1.7} />
      </Button>
    </Tooltip>
  );
});

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
  // The buttons get stable callbacks that always see the latest text.
  const latestSend = useRef(send);
  latestSend.current = send;
  const onSend = useCallback((steer: boolean) => latestSend.current(steer), []);
  const onStop = useCallback(() => void sync.abort().catch(() => {}), [sync]);

  return (
    // The composer shares the transcript column: its text starts where answers start. The dock reserves
    // the same scrollbar gutter as the transcript, so both center on the same axis.
    <div className="flex-none overflow-hidden [scrollbar-gutter:stable]">
      <div className="mx-auto max-w-220 px-8 pt-1 pb-3 narrow:px-4 narrow:pb-2">
        <div
          className="composer flex cursor-text items-end gap-2 rounded-bubble border border-input bg-popover p-1.75 shadow-composer transition duration-120 focus-within:shadow-composer-focus"
          onMouseDown={(e) => e.target === e.currentTarget && (e.preventDefault(), ref.current?.focus())}
        >
          {/* A typed shell prompt, the same "›" as the logo's "›_": decoration, not a control. The avatar
              column stays empty otherwise: it is you writing, not the bot. */}
          <span className="pointer-events-none grid h-9 w-6 flex-none place-items-center font-mono text-[17px] leading-none font-semibold text-link/70 select-none narrow:hidden" aria-hidden>
            ›
          </span>
          <textarea
            ref={ref}
            value={text}
            rows={1}
            placeholder={`Message ${name}…`}
            className="max-h-60 min-w-0 flex-1 resize-none overflow-y-hidden bg-transparent py-1.75 text-body leading-6 text-foreground outline-none placeholder:text-muted-foreground"
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
                onStop();
              }
            }}
          />
          <Actions empty={!text.trim()} running={running} onSend={onSend} onStop={onStop} />
        </div>
        {/* Only the working state's keys need explaining (idle is the usual Enter / Shift+Enter). The line
            keeps its height either way, so the transcript doesn't jump when a bot starts or stops. */}
        <div className="h-5.75 truncate pt-1.75 pl-10 text-meta leading-4 text-muted-foreground">{running ? "Enter queues · Ctrl+Enter steers · Esc stops" : ""}</div>
      </div>
    </div>
  );
});
