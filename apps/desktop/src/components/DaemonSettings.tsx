/**
 * Which daemon the app talks to, and the daemons on the user's tailnet. A daemon started with
 * `--tailscale` is at `wss://<device>.<tailnet>.ts.net:7357` and lets in the tailnet's devices (or only
 * those `--tailscale-allow` names); it tells the app who Tailscale says it is.
 */
import { Check, Copy, RefreshCw } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { cn } from "../lib/utils.ts";
import { connectTo, DEFAULT_SERVER, daemonUrl, serverUrl, top, useTailnet } from "../top.ts";
import { Section } from "./SettingsSection.tsx";
import { Button } from "./ui/button.tsx";
import { Input } from "./ui/field.tsx";

type FoundDaemon = {
  readonly device: string;
  readonly url: string;
  /** On this computer. */
  readonly self: boolean;
  readonly serverId?: string;
  /** `refused`: there's a Top, but it doesn't let this device in. */
  readonly state: "ok" | "refused";
  readonly error?: string;
};
type Discovery = { readonly ok: true; readonly daemons: readonly FoundDaemon[] } | { readonly ok: false; readonly error: string };

/** Only the desktop app can ask Tailscale (electron/preload.cjs); in a browser there's no list. */
const desktop = (window as { topDesktop?: { findTailnetDaemons?: () => Promise<Discovery> } }).topDesktop;

const sameAddress = (a: string, b: string) => daemonUrl(a) === daemonUrl(b);

function useCopied(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = useCallback((text: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1_400);
    });
  }, []);
  return [copied, copy];
}

function Address() {
  const connection = useSyncExternalStore(top.subscribe, () => top.getSnapshot().connection);
  const { viewer } = useTailnet();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(serverUrl);
  const [error, setError] = useState<string>();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const url = daemonUrl(text);
    if (!url) return setError("That isn't an address. Try box.tail1234.ts.net:7357 or 127.0.0.1:7357.");
    if (url === daemonUrl(serverUrl)) return setEditing(false);
    connectTo(url);
  };

  const state =
    connection === "open"
      ? viewer
        ? viewer.login
          ? `Connected over Tailscale as ${viewer.login}, from ${viewer.device}`
          : `Connected over Tailscale from ${viewer.device}${viewer.tags?.length ? ` (${viewer.tags.join(", ")})` : ""}`
        : "Connected"
      : connection === "connecting"
        ? "Connecting…"
        : "Can't reach it; still trying";

  if (editing)
    return (
      <form onSubmit={submit} className="flex flex-col gap-2.5 px-4.5 py-3.5">
        <label htmlFor="daemon-address" className="text-small leading-snug font-label">
          Daemon address
        </label>
        <div className="flex items-center gap-2">
          <Input
            id="daemon-address"
            autoFocus
            spellCheck={false}
            value={text}
            onValueChange={(value) => {
              setText(value);
              setError(undefined);
            }}
            placeholder="box.tail1234.ts.net:7357"
            className="font-mono text-[13px]"
          />
          <Button type="submit" size="default">
            Connect
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setEditing(false);
              setText(serverUrl);
              setError(undefined);
            }}
          >
            Cancel
          </Button>
        </div>
        {error ? (
          <p className="m-0 text-meta text-destructive-foreground">{error}</p>
        ) : (
          <p className="m-0 text-meta text-muted-foreground">
            The app starts over on the new daemon.{" "}
            {!sameAddress(serverUrl, DEFAULT_SERVER) && (
              <Button variant="link" size="link" onClick={() => connectTo(DEFAULT_SERVER)}>
                Back to this computer
              </Button>
            )}
          </p>
        )}
      </form>
    );

  return (
    <div className="flex items-center justify-between gap-6 px-4.5 py-3.5">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-small leading-snug font-label">Address</span>
        <span className="truncate text-meta text-muted-foreground">
          <span className="font-mono text-[11.5px]">{serverUrl}</span> · {state}
        </span>
      </div>
      <Button variant="outline" size="xs" className="px-2.5" onClick={() => setEditing(true)}>
        Change
      </Button>
    </div>
  );
}

/** Connected some other way: this is where phones and other computers reach the same daemon. */
function TailnetAddress({ url }: { url: string }) {
  const [copied, copy] = useCopied();
  return (
    <div className="flex items-center justify-between gap-6 px-4.5 py-3.5">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-small leading-snug font-label">On your tailnet</span>
        <span className="text-meta text-muted-foreground">
          Your phone and other computers reach this daemon at <span className="font-mono text-[11.5px] break-all">{url}</span>
        </span>
      </div>
      <Button variant="outline" size="xs" className="px-2.5" onClick={() => copy(url)}>
        {copied ? <Check size={13} /> : <Copy size={13} />}
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}

function Found({ daemon }: { daemon: FoundDaemon }) {
  const serverId = useSyncExternalStore(top.subscribe, () => top.getSnapshot().serverId);
  // The same data is the same daemon, whichever address the app reached it at.
  const current = sameAddress(daemon.url, serverUrl) || (daemon.serverId !== undefined && daemon.serverId === serverId);
  return (
    <div className="flex items-center justify-between gap-4 py-1.5">
      <div className="flex min-w-0 flex-col">
        <span className="flex items-center gap-2 text-small leading-snug font-label">
          <i className={cn("size-1.75 flex-none rounded-full", daemon.state === "ok" ? "bg-success" : "bg-muted-foreground/50")} aria-hidden />
          {daemon.device}
          {daemon.self && <span className="font-book text-muted-foreground">this computer</span>}
        </span>
        <span className="truncate pl-3.75 text-meta text-muted-foreground" title={daemon.error}>
          {daemon.state === "ok" ? <span className="font-mono text-[11.5px]">{daemon.url}</span> : "Doesn't let this device in"}
        </span>
      </div>
      {daemon.state === "ok" &&
        (current ? (
          <span className="flex-none text-meta text-muted-foreground">Connected</span>
        ) : (
          <Button size="xs" className="flex-none px-2.5" onClick={() => connectTo(daemon.url)}>
            Connect
          </Button>
        ))}
    </div>
  );
}

function Discover() {
  const [result, setResult] = useState<Discovery>();
  const [looking, setLooking] = useState(false);
  const look = useCallback(async () => {
    if (!desktop?.findTailnetDaemons) return;
    setLooking(true);
    try {
      setResult(await desktop.findTailnetDaemons());
    } catch (error) {
      setResult({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    setLooking(false);
  }, []);
  useEffect(() => void look(), [look]);

  return (
    <div className="flex flex-col gap-1.5 px-4.5 py-3.5">
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-small leading-snug font-label">Top on your tailnet</span>
          <span className="text-meta text-muted-foreground">
            Daemons started with <span className="font-mono text-[11.5px]">--tailscale</span> on your devices.
          </span>
        </div>
        <Button variant="ghost" size="xs" className="px-2.5" disabled={looking} onClick={() => void look()}>
          <RefreshCw size={13} className={cn(looking && "animate-spin motion-reduce:animate-none")} />
          {looking ? "Looking…" : "Look again"}
        </Button>
      </div>
      {result &&
        (!result.ok ? (
          <p className="m-0 text-meta text-muted-foreground">{result.error}</p>
        ) : result.daemons.length === 0 ? (
          !looking && <p className="m-0 text-meta text-muted-foreground">None found on the devices that are online.</p>
        ) : (
          <div className="flex flex-col">
            {[...result.daemons]
              .sort((a, b) => Number(b.self) - Number(a.self) || a.device.localeCompare(b.device))
              .map((daemon) => (
                <Found key={daemon.url} daemon={daemon} />
              ))}
          </div>
        ))}
    </div>
  );
}

export function DaemonSettings() {
  const { tailnetUrl, viewer } = useTailnet();
  return (
    <Section title="Daemon">
      <Address />
      {tailnetUrl && !viewer && <TailnetAddress url={tailnetUrl} />}
      {desktop?.findTailnetDaemons && <Discover />}
    </Section>
  );
}
