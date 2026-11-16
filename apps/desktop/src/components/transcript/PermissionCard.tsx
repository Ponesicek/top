/**
 * A bot asking whether it may do something (Collar's `ask_permission`), in its conversation where it
 * asked: what it wants to do and why, with Allow and Deny while the daemon holds the request, then what
 * came of it. The answer only goes back to the bot as its tool's result; nothing else waits on it.
 *
 * It takes no focus: a request arriving while you type doesn't take your keystrokes. Another device
 * answering first settles it here too.
 */

import type { QueuedMessage } from "@top/client";
import { Check, CircleSlash, X } from "lucide-react";
import { memo, useId, useState } from "react";
import { cn } from "../../lib/utils.ts";
import type { Row } from "../../rows.ts";
import { top, useClient } from "../../top.ts";
import { messageOf } from "../BotDialogs.tsx";
import { Button } from "../ui/button.tsx";

type PermissionRow = Extract<Row, { kind: "permission" }>;

const SETTLED = {
  allowed: { icon: Check, text: "Allowed", tone: "text-success-foreground" },
  denied: { icon: X, text: "Denied", tone: "text-destructive-foreground" },
  stopped: { icon: CircleSlash, text: "Not answered: the bot was stopped first", tone: "text-muted-foreground" },
  restarted: { icon: CircleSlash, text: "Not answered: Top restarted first", tone: "text-muted-foreground" },
  unanswered: { icon: CircleSlash, text: "Not answered", tone: "text-muted-foreground" },
} as const;

export const PermissionCard = memo(function PermissionCard({
  row,
  name,
  inbox,
  className,
}: {
  row: PermissionRow;
  name: string;
  /** The bot's queue: a background request's answer waits there until the bot takes it. */
  inbox: readonly QueuedMessage[];
  className?: string;
}) {
  const request = useClient((s) => (row.answer ? undefined : s.permissions.find((p) => p.bot === row.bot && p.toolCallId === row.toolCallId)));
  const online = useClient((s) => s.connection === "open");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  /** What this device answered, shown until the daemon's record of it arrives. */
  const [sent, setSent] = useState<"allowed" | "denied">();
  const titleId = useId();

  const queued = row.job === undefined ? undefined : inbox.find((m) => m.job === row.job);
  // A background request the daemon no longer holds, with no answer on its way: it was stopped.
  const answer =
    row.answer ?? (queued ? (queued.permission ?? "unanswered") : undefined) ?? sent ?? (row.job !== undefined && online && !request ? "stopped" : undefined);
  const settled = answer ? SETTLED[answer] : undefined;

  const decide = async (allow: boolean) => {
    if (!request || busy) return;
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
        aria-labelledby={titleId}
        className="flex w-fit max-w-[min(100%,32rem)] flex-col gap-1 rounded-xl bg-muted px-3.5 py-3 inset-ring inset-ring-border"
      >
        <span className="text-meta text-muted-foreground">{settled ? `${name} asked for your approval` : "Needs your approval"}</span>
        <span id={titleId} className="text-small leading-snug font-medium break-words whitespace-pre-wrap text-foreground">
          {row.ask.action}
        </span>
        {row.ask.reason && <span className="text-meta break-words whitespace-pre-wrap text-secondary-foreground">{row.ask.reason}</span>}
        {settled ? (
          <span className={cn("mt-1 inline-flex items-center gap-1.5 text-meta font-label", settled.tone)}>
            <settled.icon size={13} strokeWidth={2.4} aria-hidden />
            {settled.text}
          </span>
        ) : (
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
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
            {!online && <span className="text-meta text-muted-foreground">Reconnecting…</span>}
          </div>
        )}
        {error && (
          <span role="alert" className="text-meta text-destructive-foreground">
            {error}
          </span>
        )}
      </section>
    </div>
  );
});
