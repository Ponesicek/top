import { type BotId, type BotSummary, MAX_BOT_AVATAR, MAX_BOT_DESCRIPTION, MAX_BOT_NAME, OfflineError, TimeoutError } from "@top/client";
import * as Schema from "effect/Schema";
import { Shuffle } from "lucide-react";
import { type FormEvent, useId, useRef, useState } from "react";
import { cn } from "../lib/utils.ts";
import { top } from "../top.ts";
import { Avatar } from "./Avatar.tsx";
import { Button } from "./ui/button.tsx";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogPopup,
  Dialog,
  DialogBody,
  DialogClose,
  DialogDescription,
  DialogError,
  DialogFooter,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog.tsx";
import { Field, FieldHint, FieldLabel, Input, Textarea } from "./ui/field.tsx";
import { Tooltip } from "./ui/tooltip.tsx";

const isOffline = Schema.is(OfflineError);
const isTimeout = Schema.is(TimeoutError);

/** What went wrong, in words for the user. The daemon's own refusals already are ("There's already a bot named Atlas."). */
export function messageOf(error: unknown): string {
  if (isOffline(error)) return "Not connected to the Top daemon. Try again once it's back.";
  if (isTimeout(error)) return "The daemon didn't answer. Try again.";
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^\w+: /, "");
}

/** How many drawings the picker offers at once. */
const CHOICES = 8;
const FIRST_CHOICES: readonly number[] = Array.from({ length: CHOICES }, (_, i) => i);

/** The picked drawing kept in front, then others drawn at random. */
function shuffleAvatars(picked: number): number[] {
  const next = [picked];
  while (next.length < CHOICES) {
    const pick = 1 + Math.floor(Math.random() * MAX_BOT_AVATAR);
    if (!next.includes(pick)) next.push(pick);
  }
  return next;
}

/**
 * The bot's icon: a row of drawings of the name as typed (the daemon tidies the name the same way), so the
 * picked one is exactly what the sidebar shows. Shuffle offers more, keeping the picked one.
 */
function AvatarPicker({ name, value, onChange }: { name: string; value: number; onChange: (avatar: number) => void }) {
  const [choices, setChoices] = useState(FIRST_CHOICES);
  const label = useId();
  const drawn = name.trim().replace(/\s+/g, " ") || "Scout";
  return (
    <div className="flex flex-col gap-1.5">
      <span id={label} className="text-code leading-tight font-semibold text-secondary-foreground">
        Icon
      </span>
      {/* One row of equal cells at any width: the dialog narrows on a phone, and the row must never wrap. */}
      <div className="grid grid-cols-9 gap-1">
        <div role="radiogroup" aria-labelledby={label} className="col-span-8 grid grid-cols-subgrid">
          {choices.map((avatar, i) => (
            // biome-ignore lint/a11y/useSemanticElements: a row of pictures to pick from; TODO: Base UI RadioGroup, which adds arrow-key navigation
            <button
              key={avatar}
              type="button"
              role="radio"
              aria-checked={avatar === value}
              aria-label={`Icon ${i + 1}`}
              onClick={() => onChange(avatar)}
              className={cn(
                "grid aspect-square place-items-center rounded-field transition-[background-color,box-shadow] duration-90 hover:bg-secondary focus-visible:shadow-focus focus-visible:outline-none",
                avatar === value && "bg-secondary inset-ring-2 inset-ring-primary hover:bg-secondary",
              )}
            >
              <Avatar name={drawn} avatar={avatar} className="size-[72%]" />
            </button>
          ))}
        </div>
        <Tooltip content="More icons">
          <button
            type="button"
            aria-label="More icons"
            onClick={() => setChoices(shuffleAvatars(value))}
            className="grid aspect-square place-items-center rounded-field text-muted-foreground transition-colors duration-90 hover:bg-secondary hover:text-foreground focus-visible:shadow-focus focus-visible:outline-none"
          >
            <Shuffle size={17} strokeWidth={2} />
          </button>
        </Tooltip>
      </div>
    </div>
  );
}

/** The form lives inside the popup, so it starts empty each time the dialog opens. */
function NewBotForm({ onCreated }: { onCreated: (id: BotId) => void }) {
  const [name, setName] = useState("");
  const [avatar, setAvatar] = useState(0);
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
      onCreated(await top.createBot(name, description, avatar));
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
        <AvatarPicker name={name} value={avatar} onChange={setAvatar} />
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
export function DeleteBotDialog({
  bot,
  open,
  onOpenChange,
  onClosed,
}: {
  bot: BotSummary | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onClosed: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange} onOpenChangeComplete={(o) => !o && onClosed()}>
      <AlertDialogPopup>{bot && <DeleteBotBody key={bot.id} bot={bot} onDone={() => onOpenChange(false)} />}</AlertDialogPopup>
    </AlertDialog>
  );
}
