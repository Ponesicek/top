import { useRef, useState, type FormEvent } from "react";
import { MAX_BOT_DESCRIPTION, MAX_BOT_NAME, OfflineError, TimeoutError, type BotId, type BotSummary } from "@top/client";
import { top } from "../top.ts";
import { Button } from "./ui/button.tsx";
import { AlertDialog, AlertDialogClose, AlertDialogPopup, Dialog, DialogBody, DialogClose, DialogDescription, DialogError, DialogFooter, DialogPopup, DialogTitle } from "./ui/dialog.tsx";
import { Field, FieldHint, FieldLabel, Input, Textarea } from "./ui/field.tsx";

/** What went wrong, in words for the user. The daemon's own refusals already are ("There's already a bot named Atlas."). */
export function messageOf(error: unknown): string {
  if (error instanceof OfflineError) return "Not connected to the Top daemon. Try again once it's back.";
  if (error instanceof TimeoutError) return "The daemon didn't answer. Try again.";
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^\w+: /, "");
}

/** The form lives inside the popup, so it starts empty each time the dialog opens. */
function NewBotForm({ onCreated }: { onCreated: (id: BotId) => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const form = useRef<HTMLFormElement>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !name.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      onCreated(await top.createBot(name, description));
    } catch (err) {
      setError(messageOf(err));
      setBusy(false);
    }
  };

  return (
    <form ref={form} onSubmit={submit}>
      <DialogBody>
        <DialogTitle>New bot</DialogTitle>
        <Field>
          <FieldLabel>Name</FieldLabel>
          <Input
            value={name}
            maxLength={MAX_BOT_NAME}
            placeholder="Scout"
            spellCheck={false}
            onValueChange={(value) => {
              setName(value);
              setError(undefined);
            }}
          />
        </Field>
        <Field>
          <FieldLabel>
            Description <FieldHint>optional</FieldHint>
          </FieldLabel>
          <Textarea
            rows={4}
            value={description}
            maxLength={MAX_BOT_DESCRIPTION}
            placeholder="What is this bot for? It reads this as part of its instructions."
            onChange={(e) => setDescription(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                form.current?.requestSubmit();
              }
            }}
          />
        </Field>
        {error && <DialogError>{error}</DialogError>}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" size="wide" />}>Cancel</DialogClose>
          <Button type="submit" size="wide" disabled={busy || !name.trim()}>
            {busy ? "Creating…" : "Create bot"}
          </Button>
        </DialogFooter>
      </DialogBody>
    </form>
  );
}

export function NewBotDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (open: boolean) => void; onCreated: (id: BotId) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <NewBotForm onCreated={onCreated} />
      </DialogPopup>
    </Dialog>
  );
}

function DeleteBotBody({ bot, onDone }: { bot: BotSummary; onDone: () => void }) {
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const remove = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await top.deleteBot(bot.id);
      onDone();
    } catch (err) {
      setError(messageOf(err));
      setBusy(false);
    }
  };

  return (
    <DialogBody>
      <DialogTitle>Delete {bot.name}?</DialogTitle>
      <DialogDescription>
        {bot.status === "idle" ? "" : `${bot.name} is working; it will be stopped. `}Its whole conversation is erased, on every device. This can't be undone.
      </DialogDescription>
      {error && <DialogError>{error}</DialogError>}
      <DialogFooter>
        <AlertDialogClose render={<Button variant="outline" size="wide" />}>Cancel</AlertDialogClose>
        <Button variant="destructive" size="wide" onClick={remove} disabled={busy}>
          {busy ? "Deleting…" : "Delete bot"}
        </Button>
      </DialogFooter>
    </DialogBody>
  );
}

/** Focus starts on Cancel (the first control): Enter right after opening must not delete. */
export function DeleteBotDialog({ bot, open, onOpenChange, onClosed }: { bot: BotSummary | undefined; open: boolean; onOpenChange: (open: boolean) => void; onClosed: () => void }) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange} onOpenChangeComplete={(o) => !o && onClosed()}>
      <AlertDialogPopup>{bot && <DeleteBotBody key={bot.id} bot={bot} onDone={() => onOpenChange(false)} />}</AlertDialogPopup>
    </AlertDialog>
  );
}
