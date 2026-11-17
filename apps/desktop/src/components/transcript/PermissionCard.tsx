/**
 * A bot asking whether it may do something (Collar's `ask_permission`), in its conversation where it
 * asked: what it wants to do and why, with Allow and Deny while the request waits on the daemon, then
 * what came of it. The answer only goes back to the bot, as a message; nothing else waits on it.
 *
 * Both halves are the daemon's: whether it waits is its waiting list (`permissions`), and what came of
 * it is the `permission` entry naming it (on the row as `answer`), the same after a reload or on another
 * device. Neither known yet (offline, or the entry still on its way): the buttons stay off.
 *
 * It takes no focus when it arrives: a request coming in while you type doesn't take your keystrokes.
 * Answered from the keyboard, focus stays on the card as it settles.
 */
import { Check, CircleSlash, X } from "lucide-react";
import { memo, useId, useRef, useState } from "react";
import { cn } from "../../lib/utils.ts";
import type { Row } from "../../rows.ts";
import { top, useClient } from "../../top.ts";
import { messageOf } from "../BotDialogs.tsx";
import { Button } from "../ui/button.tsx";
import { useIdentity } from "./parts.tsx";

type PermissionRow = Extract<Row, { kind: "permission" }>;

const SETTLED = {
  allowed: { icon: Check, text: "Allowed", tone: "text-success-foreground" },
  denied: { icon: X, text: "Denied", tone: "text-destructive-foreground" },
  withdrawn: { icon: CircleSlash, text: "Not answered: the request was withdrawn", tone: "text-muted-foreground" },
} as const;

export const PermissionCard = memo(function PermissionCard({ row, className }: { row: PermissionRow; className?: string }) {
  const { name } = useIdentity();
  const id = row.ask.id;
  const waiting = useClient((s) => s.permissions.some((p) => p.id === id));
  const online = useClient((s) => s.connection === "open");
  const [error, setError] = useState<string>();
  // The daemon answers only after it has sent this client the entry and the new waiting list, so once
  // the answer is in, the card has settled (or, the entry in a part not loaded, its buttons are off).
  const [busy, setBusy] = useState(false);
  const card = useRef<HTMLElement>(null);
  const titleId = useId();
  const settled = row.answer ? SETTLED[row.answer] : undefined;

  const decide = async (allow: boolean) => {
    if (!waiting || busy) return;
    // The buttons go disabled, then away as it settles: keep focus on the card rather than dropping it to the page.
    if (card.current?.contains(document.activeElement)) card.current.focus();
    setBusy(true);
    setError(undefined);
    try {
      await top.answerPermission({ id, bot: row.bot }, allow);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };
  const off = !waiting || busy;

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
            <Button size="xs" className="h-7.5 px-3 text-meta" disabled={off} onClick={() => decide(true)} aria-describedby={titleId}>
              Allow
            </Button>
            <Button size="xs" variant="outline" className="h-7.5 px-3 text-meta" disabled={off} onClick={() => decide(false)} aria-describedby={titleId}>
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
