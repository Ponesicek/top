/**
 * A bot asking whether it may do something (Collar's `ask_permission`): what it wants to do and why,
 * with Deny and Allow. The answer goes back to the bot as its tool's result; nothing else waits on it.
 *
 * Requests from every bot come here, oldest first, one at a time. Deny comes first and has the focus, so
 * Enter right after it opens doesn't allow anything; Escape denies too. Another device answering first
 * takes the request away here as well.
 */
import type { PermissionRequest } from "@top/client";
import { useState } from "react";
import { top, useClient, useRoster } from "../top.ts";
import { Avatar } from "./Avatar.tsx";
import { messageOf } from "./BotDialogs.tsx";
import { Button } from "./ui/button.tsx";
import { AlertDialog, AlertDialogPopup, DialogBody, DialogDescription, DialogError, DialogFooter, DialogTitle } from "./ui/dialog.tsx";

export function PermissionPopup() {
  const request = useClient((s) => s.permissions[0]);
  const more = useClient((s) => Math.max(0, s.permissions.length - 1));
  // Kept while the popup closes, so it doesn't go blank as it fades out.
  const [shown, setShown] = useState<PermissionRequest>();
  if (request && request !== shown) setShown(request);
  const current = request ?? shown;
  return (
    <AlertDialog
      open={!!request}
      // Escape: a dismissal is never an Allow.
      onOpenChange={(open) => {
        if (!open && request) void top.answerPermission(request, false).catch(() => {});
      }}
      onOpenChangeComplete={(open) => !open && setShown(undefined)}
    >
      <AlertDialogPopup>{current && <PermissionBody key={current.id} request={current} more={more} />}</AlertDialogPopup>
    </AlertDialog>
  );
}

function PermissionBody({ request, more }: { request: PermissionRequest; more: number }) {
  const bot = useRoster().find((b) => b.id === request.bot);
  const name = bot?.name ?? "A bot";
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const answer = async (allow: boolean) => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      // On success the daemon takes the request off the list, and the popup moves on.
      await top.answerPermission(request, allow);
    } catch (err) {
      setError(messageOf(err));
      setBusy(false);
    }
  };

  return (
    <DialogBody>
      <div className="flex items-center gap-3">
        {bot && <Avatar name={bot.name} avatar={bot.avatar} size="sm" />}
        <DialogTitle>{name} asks for permission</DialogTitle>
      </div>
      <DialogDescription className="mt-0 flex flex-col gap-2">
        <span className="text-body font-medium break-words whitespace-pre-wrap text-foreground">{request.action}</span>
        {request.reason && <span className="break-words whitespace-pre-wrap">{request.reason}</span>}
      </DialogDescription>
      <p className="-mt-1 text-meta text-muted-foreground">
        Your answer goes back to {name}.{more > 0 && ` ${more === 1 ? "1 more request is" : `${more} more requests are`} waiting.`}
      </p>
      {error && <DialogError>{error}</DialogError>}
      <DialogFooter>
        <Button variant="outline" size="wide" onClick={() => answer(false)} disabled={busy}>
          Deny
        </Button>
        <Button size="wide" onClick={() => answer(true)} disabled={busy}>
          Allow
        </Button>
      </DialogFooter>
    </DialogBody>
  );
}
