import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { MAX_BOT_DESCRIPTION, MAX_BOT_NAME, OfflineError, TimeoutError, type BotId, type BotSummary } from "@top/client";
import { top } from "../top.ts";

/** What went wrong, in words for the user. The daemon's own refusals already are ("There's already a bot named Atlas."). */
function messageOf(error: unknown): string {
  if (error instanceof OfflineError) return "Not connected to the Top daemon. Try again once it's back.";
  if (error instanceof TimeoutError) return "The daemon didn't answer. Try again.";
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^\w+: /, "");
}

/**
 * A modal on the native <dialog>: focus stays inside, Esc and a click on the backdrop close it. Rendered
 * into <body>, outside the sidebar's window-drag region, and keys typed in it don't reach the app's
 * shortcuts (Ctrl+1…9 would switch bots behind it).
 */
function Modal({ onClose, labelledBy, children }: { onClose: () => void; labelledBy: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  return createPortal(
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby={labelledBy}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      {children}
    </dialog>,
    document.body,
  );
}

export function NewBotDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: BotId) => void }) {
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
    <Modal onClose={onClose} labelledBy="new-bot-title">
      <form ref={form} className="dialog-body" onSubmit={submit}>
        <h2 id="new-bot-title">New bot</h2>
        <label className="field">
          <span className="field-label">Name</span>
          <input
            autoFocus
            value={name}
            maxLength={MAX_BOT_NAME}
            placeholder="Scout"
            spellCheck={false}
            onChange={(e) => {
              setName(e.target.value);
              setError(undefined);
            }}
          />
        </label>
        <label className="field">
          <span className="field-label">
            Description <span className="field-hint">optional</span>
          </span>
          <textarea
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
        </label>
        {error && (
          <p className="dialog-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy || !name.trim()}>
            {busy ? "Creating…" : "Create bot"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function DeleteBotDialog({ bot, onClose }: { bot: BotSummary; onClose: () => void }) {
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const remove = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await top.deleteBot(bot.id);
      onClose();
    } catch (err) {
      setError(messageOf(err));
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} labelledBy="delete-bot-title">
      <div className="dialog-body">
        <h2 id="delete-bot-title">Delete {bot.name}?</h2>
        <p className="dialog-text">
          {bot.status === "idle" ? "" : `${bot.name} is working; it will be stopped. `}Its whole conversation is erased, on every device. This can't be undone.
        </p>
        {error && (
          <p className="dialog-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="ghost" onClick={onClose} autoFocus>
            Cancel
          </button>
          <button type="button" className="primary danger" onClick={remove} disabled={busy}>
            {busy ? "Deleting…" : "Delete bot"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
