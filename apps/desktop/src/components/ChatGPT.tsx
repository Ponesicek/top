/**
 * Sign in with ChatGPT, from the app: the settings section (which says the bots are using the user's
 * ChatGPT plan, with its "Manage usage" link), the dialog that signs in, and the gate that holds the app
 * until the bots can answer.
 *
 * The browser comes back to 127.0.0.1:1455 on the computer it ran on. On the daemon's computer, the
 * daemon is listening there and the dialog closes by itself. Anywhere else, that page fails to load, and
 * the user pastes its address here.
 */
import { type AccountView, CHATGPT_BACKGROUND_NOTICE, CHATGPT_REDIRECT, CHATGPT_USAGE_URL } from "@top/client";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { top, useClient } from "../top.ts";
import { messageOf } from "./BotDialogs.tsx";
import { Section } from "./SettingsSection.tsx";
import { Button } from "./ui/button.tsx";
import { Dialog, DialogBody, DialogClose, DialogDescription, DialogError, DialogFooter, DialogPopup, DialogTitle } from "./ui/dialog.tsx";
import { Field, FieldHint, FieldLabel, Input } from "./ui/field.tsx";

export function useAccount(): AccountView | undefined {
  return useClient((snapshot) => snapshot.account);
}

function ManageUsage() {
  return (
    <a href={CHATGPT_USAGE_URL} target="_blank" rel="noreferrer" className="text-link underline-offset-2 hover:underline">
      Manage usage
    </a>
  );
}

/**
 * The dialog's steps: agree to background use, then sign in (and paste the address, from elsewhere).
 * `required`: the gate, which has no Cancel; Back starts over instead.
 */
function SignInForm({ onDone, required = false }: { onDone: () => void; required?: boolean }) {
  const account = useAccount();
  const [url, setUrl] = useState<string>();
  const [pasted, setPasted] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const started = useRef(false);

  // Signed in on the daemon's computer: the daemon got the browser's answer itself.
  useEffect(() => {
    if (started.current && account?.signedIn === "chatgpt" && !account.signingIn) onDone();
  }, [account, onDone]);

  const act = async (run: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await run();
    } catch (err) {
      setError(messageOf(err));
    }
    setBusy(false);
  };

  const begin = () =>
    act(async () => {
      started.current = true;
      const page = await top.chatgptSignIn();
      setUrl(page);
      window.open(page, "_blank", "noopener");
    });

  const finish = (e: FormEvent) => {
    e.preventDefault();
    if (!pasted.trim()) return;
    void act(async () => {
      await top.chatgptSignInFinish(pasted.trim());
      onDone();
    });
  };

  if (!url)
    return (
      <DialogBody>
        <DialogTitle>Continue with ChatGPT</DialogTitle>
        <DialogDescription>Your bots use your ChatGPT plan instead of an API key. Top can't see your ChatGPT conversations.</DialogDescription>
        <p className="m-0 rounded-field bg-secondary px-3.5 py-3 text-small leading-normal text-secondary-foreground">
          {CHATGPT_BACKGROUND_NOTICE} <ManageUsage />
        </p>
        {error && <DialogError>{error}</DialogError>}
        <DialogFooter>
          {!required && <DialogClose render={<Button variant="outline" size="wide" />}>Cancel</DialogClose>}
          <Button size="wide" disabled={busy} onClick={() => void begin()}>
            {busy ? "Starting…" : "Agree and continue"}
          </Button>
        </DialogFooter>
      </DialogBody>
    );

  return (
    <form onSubmit={finish}>
      <DialogBody>
        <DialogTitle>Sign in with ChatGPT</DialogTitle>
        <DialogDescription>
          On the daemon's computer, this closes by itself once you've signed in.{" "}
          <button type="button" className="text-link underline-offset-2 hover:underline" onClick={() => window.open(url, "_blank", "noopener")}>
            Didn't open? Open the sign-in page
          </button>
        </DialogDescription>
        <Field>
          <FieldLabel>Signing in on another device?</FieldLabel>
          <Input
            value={pasted}
            placeholder={`${CHATGPT_REDIRECT}?code=…`}
            spellCheck={false}
            autoComplete="off"
            className="font-mono text-[13px]"
            onValueChange={(value) => {
              setPasted(value);
              setError(undefined);
            }}
          />
          <FieldHint className="text-meta">The page won't load there; that's expected. Copy its address from the address bar and paste it here.</FieldHint>
        </Field>
        {(error ?? account?.error) && <DialogError>{error ?? account?.error}</DialogError>}
        <DialogFooter>
          {required ? (
            <Button
              variant="outline"
              size="wide"
              onClick={() => {
                // Drop the sign-in, so the daemon's listener on :1455 goes too.
                void top.chatgptSignInCancel().catch(() => {});
                started.current = false;
                setUrl(undefined);
                setPasted("");
                setError(undefined);
              }}
            >
              Back
            </Button>
          ) : (
            <DialogClose render={<Button variant="outline" size="wide" />}>Cancel</DialogClose>
          )}
          <Button type="submit" size="wide" disabled={busy || !pasted.trim()}>
            {busy ? "Signing in…" : "Finish"}
          </Button>
        </DialogFooter>
      </DialogBody>
    </form>
  );
}

export function SignInDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Closed before it finished: drop the sign-in, so the daemon's listener on :1455 goes too.
        if (!next && top.getSnapshot().account?.signingIn) void top.chatgptSignInCancel().catch(() => {});
        onOpenChange(next);
      }}
    >
      <DialogPopup className="w-125">{open && <SignInForm onDone={() => onOpenChange(false)} />}</DialogPopup>
    </Dialog>
  );
}

function statusLine(account: AccountView) {
  switch (account.signedIn) {
    case "chatgpt":
      return (
        <>
          Using ChatGPT plan · <ManageUsage />
        </>
      );
    case "apiKey":
      return "Signed in with an API key.";
    case undefined:
      return account.canSignIn
        ? "Not signed in. The bots can't answer until you sign in."
        : "Not signed in. Set the provider's API key on the daemon's computer.";
  }
}

/** Settings: the bots' model and what it's signed in with. Absent on a daemon with fake bots. */
export function AccountSection() {
  const account = useAccount();
  const [dialog, setDialog] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  if (!account) return null;
  const signOut = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await top.chatgptSignOut();
    } catch (err) {
      setError(messageOf(err));
    }
    setBusy(false);
  };
  const problem = error ?? account.error;
  return (
    <Section title="Model">
      <div className="flex flex-col gap-2 px-4.5 py-3.5">
        <div className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="truncate font-mono text-[13px] leading-snug">{account.model}</span>
            <span className="text-meta text-muted-foreground">{statusLine(account)}</span>
          </div>
          {account.signedIn === "chatgpt" ? (
            <Button variant="outline" size="xs" className="px-2.5" disabled={busy} onClick={() => void signOut()}>
              Sign out
            </Button>
          ) : (
            account.canSignIn && (
              <Button size="xs" className="px-2.5" onClick={() => setDialog(true)}>
                Continue with ChatGPT
              </Button>
            )
          )}
        </div>
        {problem && <span className="text-meta text-destructive-foreground">{problem}</span>}
      </div>
      <SignInDialog open={dialog} onOpenChange={setDialog} />
    </Section>
  );
}

/**
 * Not signed in, on a daemon whose model takes Sign in with ChatGPT: the bots can't answer, so the app
 * asks for it first, in a dialog that doesn't close until they can.
 */
export function SignInGate() {
  const account = useAccount();
  const open = !!account && !account.signedIn && account.canSignIn;
  return (
    // Controlled and never closed from inside: Escape and outside clicks ask to close, and nothing listens.
    <Dialog open={open} disablePointerDismissal>
      <DialogPopup className="w-125">{open && <SignInForm required onDone={() => {}} />}</DialogPopup>
    </Dialog>
  );
}
