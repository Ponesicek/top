import { type BotId, type BotSummary, MAX_BOT_AVATAR, MAX_BOT_DESCRIPTION, MAX_BOT_NAME, OfflineError, TimeoutError } from "@top/client";
import * as Schema from "effect/Schema";
import { Shuffle } from "lucide-react";
import { type FormEvent, type RefObject, useRef, useState } from "react";
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

export function messageOf(error: unknown): string {
  if (isOffline(error)) return "Not connected to the Top daemon. Try again once it's back.";
  if (isTimeout(error)) return "The daemon didn't answer. Try again.";
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^\w+: /, "");
}

const CHOICES = 8;
const FIRST_CHOICES: readonly number[] = Array.from({ length: CHOICES }, (_, i) => i);

function shuffleAvatars(picked: number): number[] {
  const next = [picked];
  while (next.length < CHOICES) {
    const pick = 1 + Math.floor(Math.random() * MAX_BOT_AVATAR);
    if (!next.includes(pick)) next.push(pick);
  }
  return next;
}

function AvatarPicker({ name, value, onChange }: { name: string; value: number; onChange: (avatar: number) => void }) {
  const [choices, setChoices] = useState(FIRST_CHOICES);
  const drawn = name.trim().replace(/\s+/g, " ") || "Scout";
  return (
    <div className="grid grid-cols-9 gap-0.5 rounded-field bg-secondary p-0.75">
      <div role="radiogroup" aria-label="Icon" className="col-span-8 grid grid-cols-subgrid">
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
              "grid aspect-square place-items-center rounded-[7px] transition-[background-color,box-shadow] duration-90 hover:bg-popover/60 focus-visible:shadow-focus focus-visible:outline-none",
              avatar === value && "bg-popover shadow-row-selected inset-ring-2 inset-ring-primary hover:bg-popover",
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
          className="grid aspect-square place-items-center rounded-[7px] text-muted-foreground transition-colors duration-90 hover:bg-popover/60 hover:text-foreground focus-visible:shadow-focus focus-visible:outline-none"
        >
          <Shuffle size={17} strokeWidth={2} />
        </button>
      </Tooltip>
    </div>
  );
}

function NewBotForm({ onCreated, nameRef }: { onCreated: (id: BotId) => void; nameRef: RefObject<HTMLInputElement | null> }) {
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
        <AvatarPicker name={name} value={avatar} onChange={setAvatar} />
        <Field>
          <FieldLabel>Name</FieldLabel>
          <Input
            ref={nameRef}
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
  const nameRef = useRef<HTMLInputElement>(null);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup initialFocus={nameRef}>
        <NewBotForm onCreated={onCreated} nameRef={nameRef} />
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
