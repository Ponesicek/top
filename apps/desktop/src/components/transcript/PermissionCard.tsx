/**
 * A bot asking whether it may do something (Collar's `ask_permission`), in its conversation where it
 * asked: what it wants to do and why, with Allow and Deny while the daemon holds the request, then what
 * came of it. The answer only goes back to the bot as its tool's result; nothing else waits on it.
 *
 * It takes no focus when it arrives: a request coming in while you type doesn't take your keystrokes.
 * Answered from the keyboard, focus stays on the card as it settles. Another device answering first
 * settles it here too.
 */
import type { QueuedMessage } from "@top/client";
import { Check, CircleSlash, X } from "lucide-react";
import { memo, useEffect, useId, useRef, useState } from "react";
import { cn } from "../../lib/utils.ts";
import type { Row } from "../../rows.ts";
import { top, useClient } from "../../top.ts";
import { messageOf } from "../BotDialogs.tsx";
import { Button } from "../ui/button.tsx";

type PermissionRow = Extract<Row, { kind: "permission" }>;

/**
 * How long a background request must be gone from the daemon's list, with no answer arriving, before
 * the card says it's no longer waiting: an answer reaches the list a moment before its message does.
 */
const WITHDRAWN_AFTER_MS = 2_000;

const SETTLED = {
  allowed: { icon: Check, text: "Allowed", tone: "text-success-foreground" },
  denied: { icon: X, text: "Denied", tone: "text-destructive-foreground" },
  stopped: { icon: CircleSlash, text: "Not answered: the request was withdrawn", tone: "text-muted-foreground" },
  restarted: { icon: CircleSlash, text: "Not answered: Top restarted first", tone: "text-muted-foreground" },
} as const;

export const PermissionCard = memo(function PermissionCard({
  row,
  name,
  queued,
  className,
}: {
  row: PermissionRow;
  name: string;
  /** Its job's message, while it waits in the bot's queue (a background request's answer). */
  queued: QueuedMessage | undefined;
  className?: string;
}) {
  const request = useClient((s) => (row.answer ? undefined : s.permissions.find((p) => p.bot === row.bot && p.toolCallId === row.toolCallId)));
  const online = useClient((s) => s.connection === "open");
  // The daemon's list for this connection has arrived: only then does a missing request mean anything.
  const synced = useClient((s) => s.permissionsSynced);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  /** What this device answered, shown until the daemon's record of it arrives. */
  const [sent, setSent] = useState<"allowed" | "denied">();
  const card = useRef<HTMLElement>(null);
  const titleId = useId();

  // A background request gone from the list with no answer on its way, for a moment: it was withdrawn.
  const missing = row.job !== undefined && !row.answer && !queued && !sent && synced && !request;
  const [withdrawn, setWithdrawn] = useState(false);
  useEffect(() => {
    setWithdrawn(false);
    if (!missing) return;
    const timer = setTimeout(() => setWithdrawn(true), WITHDRAWN_AFTER_MS);
    return () => clearTimeout(timer);
  }, [missing]);

  const answer = row.answer ?? (queued ? (queued.permission ?? "restarted") : undefined) ?? sent ?? (missing && withdrawn ? "stopped" : undefined);
  const settled = answer ? SETTLED[answer] : undefined;

  const decide = async (allow: boolean) => {
    if (!request || busy) return;
    // The buttons go disabled, then away as it settles: keep focus on the card rather than dropping it to the page.
    if (card.current?.contains(document.activeElement)) card.current.focus();
    setBusy(true);
    setError(undefined);
    try {
      await top.answerPermission(request, allow);
      setSent(allow ? "allowed" : "denied");
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={cn("py-1.5", className)}>
      <section
        ref={card}
        tabIndex={-1}
        aria-labelledby={titleId}
        className="flex w-fit max-w-[min(100%,32rem)] flex-col gap-1 rounded-xl bg-muted px-3.5 py-3 inset-ring inset-ring-border outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      >
        <span className="text-meta text-muted-foreground">{settled ? `${name} asked for your approval` : "Needs your approval"}</span>
        <span id={titleId} className="text-small leading-snug font-medium break-words whitespace-pre-wrap text-foreground">
          {row.ask.action}
        </span>
        {row.ask.reason && <span className="text-meta break-words whitespace-pre-wrap text-secondary-foreground">{row.ask.reason}</span>}
        {!settled && (
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-meta">
            <Button size="xs" className="h-7.5 px-3 text-meta" disabled={!request || busy} onClick={() => decide(true)} aria-describedby={titleId}>
              Allow
            </Button>
            <Button
              size="xs"
              variant="outline"
              className="h-7.5 px-3 text-meta"
              disabled={!request || busy}
              onClick={() => decide(false)}
              aria-describedby={titleId}
            >
              Deny
            </Button>
            {!online && <span className="text-muted-foreground">Reconnecting…</span>}
          </div>
        )}
        {/* Always there, so screen readers announce the outcome when it lands. */}
        <div role="status" className={settled ? "text-meta" : "-mt-1"}>
          {settled && (
            <span className={cn("mt-1 inline-flex items-center gap-1.5 font-label", settled.tone)}>
              <settled.icon size={13} strokeWidth={2.4} aria-hidden />
              {settled.text}
            </span>
          )}
        </div>
        {error && !settled && (
          <span role="alert" className="text-meta text-destructive-foreground">
            {error}
          </span>
        )}
      </section>
    </div>
  );
});
