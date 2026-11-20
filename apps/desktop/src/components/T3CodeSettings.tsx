import { type T3CodeView, TimeoutError } from "@top/client";
import * as Schema from "effect/Schema";
import { ChevronRight } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from "react";
import { cn } from "../lib/utils.ts";
import { top } from "../top.ts";
import { messageOf } from "./BotDialogs.tsx";
import { Section } from "./SettingsSection.tsx";
import { Button } from "./ui/button.tsx";
import { Dialog, DialogBody, DialogClose, DialogDescription, DialogError, DialogFooter, DialogPopup, DialogTitle } from "./ui/dialog.tsx";
import { Field, FieldHint, FieldLabel, Input } from "./ui/field.tsx";
import { Switch } from "./ui/switch.tsx";

const isTimeout = Schema.is(TimeoutError);

const PAIRING_COMMAND = "t3 auth pairing create --scope orchestration:read --scope orchestration:operate --label Top";

/** Plain HTTP to anything but this computer needs saying yes to; the daemon checks it again. */
function plainRemote(address: string): boolean {
  try {
    const url = new URL(address.trim());
    return url.protocol === "http:" && !/^(localhost|127(\.\d+){3}|\[::1\])$/.test(url.hostname);
  } catch {
    return false;
  }
}

const day = (iso: string) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
};

function ConnectForm({ address: initial, onDone, onFailed }: { address: string; onDone: (view: T3CodeView) => void; onFailed: () => void }) {
  const [address, setAddress] = useState(initial);
  const [code, setCode] = useState("");
  const [plainHttp, setPlainHttp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const plainId = useId();
  const plainHintId = useId();
  const plain = plainRemote(address);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !address.trim() || !code.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      onDone(await top.t3codeConnect(address.trim(), code, plain && plainHttp));
    } catch (err) {
      setError(messageOf(err));
      setBusy(false);
      // The daemon may still finish pairing after the app stops waiting: show what it has.
      if (isTimeout(err)) onFailed();
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)}>
      <DialogBody>
        <DialogTitle>Connect T3 Code</DialogTitle>
        <DialogDescription>
          Your bots can hand coding tasks to T3 Code, on this computer or another one. Top pairs with it through T3 Code's own API: no relay, and nothing about
          either computer's network changes.
        </DialogDescription>
        <Field>
          <FieldLabel>T3 Code's address</FieldLabel>
          <Input
            value={address}
            placeholder="http://127.0.0.1:3773"
            spellCheck={false}
            autoComplete="off"
            inputMode="url"
            className="font-mono text-[13px]"
            onValueChange={(value) => {
              setAddress(value);
              setError(undefined);
            }}
          />
          <FieldHint className="text-meta">
            On this computer, <span className="font-mono">http://127.0.0.1:3773</span>. On another, its Tailscale Serve address (
            <span className="font-mono">https://….ts.net</span>) or an SSH forward to it.
          </FieldHint>
        </Field>
        <Field>
          <FieldLabel>Pairing code</FieldLabel>
          <Input
            type="password"
            value={code}
            placeholder="The code, or the whole pairing link"
            spellCheck={false}
            autoComplete="off"
            className="font-mono text-[13px]"
            onValueChange={(value) => {
              setCode(value);
              setError(undefined);
            }}
          />
          <FieldHint className="flex flex-col gap-1 text-meta">
            <span>In T3 Code, open Settings → Sharing &amp; access and create a pairing link. Or, on T3 Code's computer, run:</span>
            <code className="rounded-sm bg-secondary px-1.5 py-1 font-mono text-[11.5px] break-all text-secondary-foreground select-all">
              {PAIRING_COMMAND}
            </code>
            <span>A code works once and expires soon. Top trades it for its own session and never shows it again.</span>
          </FieldHint>
        </Field>
        {plain && (
          <div className="flex items-start justify-between gap-4 rounded-field bg-secondary px-3 py-2.5">
            <div className="flex flex-col gap-0.5">
              <span id={plainId} className="text-small leading-snug font-label">
                Allow plain HTTP
              </span>
              <span id={plainHintId} className="text-meta text-muted-foreground">
                The code and Top's session travel unencrypted unless the network encrypts them, as a tailnet does.
              </span>
            </div>
            <Switch checked={plainHttp} onCheckedChange={setPlainHttp} aria-labelledby={plainId} aria-describedby={plainHintId} />
          </div>
        )}
        {error && <DialogError>{error}</DialogError>}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" size="wide" />}>Cancel</DialogClose>
          <Button type="submit" size="wide" disabled={busy || !address.trim() || !code.trim()}>
            {busy ? "Connecting…" : "Connect"}
          </Button>
        </DialogFooter>
      </DialogBody>
    </form>
  );
}

function statusLine(view: T3CodeView, checking: boolean): string {
  if (checking) return "Checking…";
  if (view.error) return "Can't use it now";
  return ["Connected", view.serverVersion && `T3 Code ${view.serverVersion}`, view.expiresAt && `session until ${day(view.expiresAt)}`]
    .filter(Boolean)
    .join(" · ");
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

type Detail = { readonly key: string; readonly title: string; readonly meta: string | undefined; readonly path?: string };

/** Providers and projects, one per line: shown only when asked for, and searchable once there are many. */
function Details({ view, id }: { view: T3CodeView; id: string }) {
  const [query, setQuery] = useState("");
  const items: Detail[] = [
    ...(view.providers ?? []).map((p) => ({
      key: `p:${p.id}`,
      title: p.id,
      meta: [p.status === "ready" ? p.defaultModel : p.status].filter(Boolean).join(" · ") || undefined,
    })),
    ...(view.projects ?? []).map((p) => ({ key: `j:${p.path}`, title: p.title, meta: undefined, path: p.path })),
  ];
  const needle = query.trim().toLowerCase();
  const shown = needle ? items.filter((i) => `${i.title} ${i.meta ?? ""} ${i.path ?? ""}`.toLowerCase().includes(needle)) : items;
  return (
    <div id={id} className="flex flex-col gap-1.5 pl-3.75">
      {items.length > 8 && (
        <Input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
          placeholder="Filter"
          aria-label="Filter providers and projects"
          className="py-1.5 text-small narrow:min-h-11"
        />
      )}
      <ul className="m-0 flex max-h-60 list-none flex-col overflow-y-auto rounded-field bg-secondary p-1 text-meta">
        {shown.map((item) => (
          <li key={item.key} className="flex min-w-0 items-baseline gap-2 rounded-md px-2 py-1" title={item.path ?? item.title}>
            <span className="flex-none text-micro text-muted-foreground narrow:hidden">{item.path === undefined ? "Provider" : "Project"}</span>
            <span className="max-w-[60%] min-w-0 flex-none truncate font-label text-foreground">{item.title}</span>
            {item.meta && <span className="min-w-0 truncate text-muted-foreground">{item.meta}</span>}
            {item.path && (
              <span className="min-w-0 flex-1 truncate text-right font-mono text-[11px] text-muted-foreground [direction:rtl]">
                <bdi>{item.path}</bdi>
              </span>
            )}
          </li>
        ))}
        {shown.length === 0 && <li className="px-2 py-1 text-muted-foreground">{items.length ? "No match" : "No providers or projects yet"}</li>}
      </ul>
    </div>
  );
}

function Connected({
  view,
  checking,
  onCheck,
  onPair,
  onDisconnected,
}: {
  view: T3CodeView;
  checking: boolean;
  onCheck: () => void;
  onPair: () => void;
  onDisconnected: () => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const disconnect = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await top.t3codeDisconnect();
      onDisconnected();
    } catch (err) {
      setError(messageOf(err));
    }
    setBusy(false);
    setConfirm(false);
  };
  const problem = error ?? (checking ? undefined : view.error);
  const ok = !checking && !view.error;
  const providers = view.providers?.length ?? 0;
  const ready = view.providers?.filter((p) => p.status === "ready").length ?? 0;
  const projects = view.projects?.length ?? 0;
  return (
    <div className="flex flex-col gap-2.5 px-4.5 py-3.5">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-2">
            <i
              className={cn(
                "size-1.75 flex-none rounded-full",
                checking ? "animate-pulse bg-warning motion-reduce:animate-none" : ok ? "bg-success" : "bg-destructive",
              )}
              aria-hidden
            />
            <span className="truncate text-small leading-snug font-label" title={view.url}>
              {view.label ?? view.url}
            </span>
          </span>
          <span className="pl-3.75 text-meta text-muted-foreground" role="status">
            {statusLine(view, checking)}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 pl-3.75">
          {view.error && !checking && (
            <Button size="xs" className="px-2.5 narrow:min-h-11" onClick={onPair}>
              Pair again
            </Button>
          )}
          <Button variant="outline" size="xs" className="px-2.5 narrow:min-h-11" disabled={checking || busy} onClick={onCheck}>
            Check
          </Button>
          <Button
            variant={confirm ? "destructive" : "ghost-destructive"}
            size="xs"
            className="px-2.5 narrow:min-h-11"
            disabled={busy}
            onClick={() => (confirm ? void disconnect() : setConfirm(true))}
            onBlur={() => setConfirm(false)}
          >
            {busy ? "Disconnecting…" : confirm ? "Click again to disconnect" : "Disconnect"}
          </Button>
        </div>
      </div>
      {problem && (
        <p className="m-0 line-clamp-4 pl-3.75 font-mono text-[11.5px] leading-normal whitespace-pre-wrap text-destructive-foreground" title={problem}>
          {problem}
        </p>
      )}
      {ok && (
        <Button
          variant="link"
          size="link"
          className="ml-3.75 max-w-[calc(100%-0.9375rem)] self-start text-left whitespace-normal text-muted-foreground narrow:min-h-11"
          aria-expanded={open}
          aria-controls={open ? detailsId : undefined}
          onClick={() => setOpen((o) => !o)}
        >
          <ChevronRight size={13} strokeWidth={2.2} className={cn("transition-transform duration-120 motion-reduce:transition-none", open && "rotate-90")} />
          {plural(providers, "provider")}
          {ready < providers && ` (${ready} ready)`} · {plural(projects, "project")}
        </Button>
      )}
      {ok && open && <Details view={view} id={detailsId} />}
      {confirm && (
        <p className="m-0 pl-3.75 text-meta leading-normal text-muted-foreground">
          Running tasks keep going. To revoke Top's session in T3 Code too: Settings → Sharing &amp; access.
        </p>
      )}
    </div>
  );
}

export function T3CodeSettings() {
  const [view, setView] = useState<T3CodeView>();
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState<string>();
  const [dialog, setDialog] = useState(false);
  const [forgotten, setForgotten] = useState<string>();
  const latest = useRef(0);

  // Asked when Settings opens and when you press Check; never polled.
  const check = useCallback(async () => {
    const asked = ++latest.current;
    setChecking(true);
    setError(undefined);
    try {
      const next = await top.t3code();
      if (asked === latest.current) setView(next);
    } catch (err) {
      if (asked === latest.current) setError(messageOf(err));
    }
    if (asked === latest.current) setChecking(false);
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  const connected = !!view?.url;
  return (
    <>
      <Section
        title="T3 Code"
        action={
          !connected &&
          view && (
            <Button variant="link" size="link" onClick={() => setDialog(true)}>
              Connect
            </Button>
          )
        }
      >
        {connected ? (
          <Connected
            view={view}
            checking={checking}
            onCheck={() => void check()}
            onPair={() => setDialog(true)}
            onDisconnected={() => {
              latest.current++;
              setForgotten(view.label ?? view.url);
              setView({});
              setChecking(false);
            }}
          />
        ) : (
          <div className="flex flex-col gap-2 px-4.5 py-3.5">
            <p className="m-0 text-meta leading-normal text-muted-foreground" role="status">
              {!view && checking ? "Checking…" : "Not connected"}
            </p>
            {forgotten && (
              <p className="m-0 text-meta leading-normal text-muted-foreground">
                Top forgot its session with {forgotten}. It stays valid in T3 Code until it expires: revoke it there, in Settings → Sharing &amp; access, to end
                it now.
              </p>
            )}
            {(error ?? view?.error) && <p className="m-0 text-meta leading-normal text-destructive-foreground">{error ?? view?.error}</p>}
            {error && (
              <Button variant="outline" size="xs" className="self-start px-2.5" disabled={checking} onClick={() => void check()}>
                Try again
              </Button>
            )}
          </div>
        )}
        {connected && error && <p className="m-0 px-4.5 pb-3.5 text-meta leading-normal text-destructive-foreground">{error}</p>}
      </Section>
      <Dialog open={dialog} onOpenChange={setDialog}>
        <DialogPopup className="w-130">
          {dialog && (
            <ConnectForm
              address={view?.url ?? ""}
              onDone={(next) => {
                latest.current++;
                setView(next);
                setChecking(false);
                setError(undefined);
                setForgotten(undefined);
                setDialog(false);
              }}
              onFailed={() => void check()}
            />
          )}
        </DialogPopup>
      </Dialog>
    </>
  );
}
