import { channelName } from "@top/client";
import { Download, LoaderCircle, RefreshCw, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { cn } from "../lib/utils.ts";
import { useClient } from "../top.ts";
import { describeUpdates } from "../updateFlow.ts";
import { checkBoth, mismatchText, startUpdate, useAgo, useUpdateJob, useUpdates } from "../updates.ts";
import { Button } from "./ui/button.tsx";

const OPEN_DELAY_MS = 250;
const CLOSE_DELAY_MS = 180;

const TITLE = {
  unavailable: "Updates",
  idle: "Up to date",
  checking: "Checking for updates…",
  available: "Update ready",
  working: "Updating…",
  failed: "Update didn't finish",
} as const;

export function UpdateButton({ onOpenSettings }: { onOpenSettings: () => void }) {
  const updates = useUpdates();
  const job = useUpdateJob();
  const status = describeUpdates({ server: updates.server, app: updates.app, serverVersion: updates.serverVersion, connection: updates.connection, job });
  const { server, app, mismatch } = updates;
  const bots = useClient((s) => s.bots);
  const lastChecked = useAgo(Math.max(server?.checkedAt ?? 0, app?.checkedAt ?? 0) || undefined);
  const cardId = useId();

  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const lastPointer = useRef<string>("mouse");
  const hovered = useRef(false);
  const later = useCallback((next: boolean, ms: number) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(next), ms);
  }, []);
  const now = useCallback((next: boolean) => {
    clearTimeout(timer.current);
    setOpen(next);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!wrapper.current?.contains(e.target as Node)) now(false);
    };
    const onEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") now(false);
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", onEscape);
    };
  }, [open, now]);

  const act = () => {
    if (status.action === "install") startUpdate(status.plan);
    else if (status.action === "check") void checkBoth(updates);
  };

  const offer = status.kind === "available" || (status.kind === "failed" && status.action === "install");
  const serverOffer = server?.available;
  const appOffer = app && app.state !== "unavailable" ? app.available : undefined;
  const notes = [...new Set([...(serverOffer?.notes ?? []), ...(appOffer?.notes ?? [])])].slice(0, 5);
  const busyBots = bots.filter((b) => b.status === "thinking" || b.status === "tool" || b.status === "retrying").map((b) => b.name);
  const channel = server?.channel ?? (app?.state !== "unavailable" ? app?.channel : undefined);
  const disconnected = !!status.plan.server && updates.connection !== "open" && status.kind !== "working";
  const mark =
    status.kind === "failed" ? "bg-destructive" : status.kind === "available" ? "bg-primary" : mismatch && status.kind !== "working" ? "bg-warning" : undefined;
  const pill = status.kind === "available" && updates.connection === "open";
  const Icon = status.kind === "working" ? LoaderCircle : status.kind === "available" ? Download : RefreshCw;
  const announce = status.error ?? status.progress.at(-1)?.replace(/ \(\d+%\)/, "") ?? (status.kind === "unavailable" ? "" : TITLE[status.kind]);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover and focus of the button and its card, together; the button itself is the control
    <span
      ref={wrapper}
      className="flex"
      onPointerEnter={(e) => {
        if (e.pointerType !== "mouse") return;
        hovered.current = true;
        later(true, OPEN_DELAY_MS);
      }}
      onPointerLeave={(e) => {
        if (e.pointerType !== "mouse") return;
        hovered.current = false;
        later(false, CLOSE_DELAY_MS);
      }}
      onFocus={(e) => {
        if (e.target.matches(":focus-visible")) now(true);
      }}
      onBlur={(e) => {
        if (!hovered.current && !e.currentTarget.contains(e.relatedTarget as Node | null)) now(false);
      }}
    >
      <Button
        variant={pill ? "outline" : "ghost"}
        size={pill ? "xs" : "icon"}
        className={cn(
          "relative",
          pill ? "h-8 gap-1.5 px-2.5 text-primary inset-ring-primary/35 narrow:size-8 narrow:px-0" : "size-8 text-secondary-foreground hover:text-foreground",
          open && !pill && "bg-foreground/7 text-foreground",
        )}
        aria-label={status.label}
        aria-expanded={open}
        aria-controls={open ? cardId : undefined}
        aria-disabled={status.action === "none" || disconnected || undefined}
        onPointerDown={(e) => {
          lastPointer.current = e.pointerType;
        }}
        onClick={() => {
          if (lastPointer.current === "touch" || status.action === "none" || disconnected) return now(!open);
          lastPointer.current = "mouse";
          act();
        }}
      >
        <Icon size={16} strokeWidth={1.9} className={cn((status.kind === "working" || status.kind === "checking") && "motion-safe:animate-spin")} aria-hidden />
        {pill && <span className="narrow:hidden">Update</span>}
        {mark && <i className={cn("absolute top-1 right-1 size-1.75 rounded-full ring-2 ring-sidebar", mark, pill && "narrow:block hidden")} aria-hidden />}
      </Button>
      <span className="sr-only" role="status">
        {announce}
      </span>
      {open && (
        <section
          id={cardId}
          aria-label={TITLE[status.kind]}
          className="absolute bottom-full left-2 z-50 pb-1 [-webkit-app-region:no-drag] narrow:left-1"
          onPointerEnter={(e) => {
            if (e.pointerType === "mouse") now(true);
          }}
        >
          <div className="flex w-88 max-w-[calc(100vw-1.5rem)] flex-col gap-2.5 rounded-2xl bg-popover px-4.5 py-4 text-left shadow-popover transition duration-100 starting:translate-y-1 starting:opacity-0">
            <div className="flex items-center gap-2">
              <strong className="text-small font-label">{TITLE[status.kind]}</strong>
              {channel && <span className="rounded-full bg-secondary px-2 py-0.5 text-micro text-secondary-foreground">{channelName(channel)}</span>}
            </div>

            {status.versions.length > 0 && (
              <div className="flex flex-col font-mono text-[12px] text-secondary-foreground">
                {status.versions.map((v) => (
                  <span key={v}>{v}</span>
                ))}
              </div>
            )}

            {(offer || status.kind === "working") && notes.length > 0 && (
              <ul className="m-0 flex list-disc flex-col gap-0.5 pl-4.5 text-meta text-secondary-foreground">
                {notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            )}

            {status.kind === "unavailable" && (
              <span className="text-meta text-muted-foreground">
                {updates.serverChannel
                  ? "Your server updates itself once it's installed with `top install`."
                  : "Your server runs from a checkout of Top's code: update it with git pull."}{" "}
                {app ? "So does this app." : "This page updates with the server."}
              </span>
            )}

            {status.kind === "idle" && (
              <span className="text-meta text-muted-foreground">
                {[server && `Server: Top ${server.current}`, app && app.state !== "unavailable" && `This app: Top ${app.version}`].filter(Boolean).join(" · ")}
              </span>
            )}

            {status.progress.length > 0 && (
              <div className="flex flex-col gap-0.5 text-meta text-muted-foreground">
                {status.progress.map((line) => (
                  <span key={line}>{line}</span>
                ))}
              </div>
            )}

            {offer && serverOffer && busyBots.length > 0 && (
              <span className="text-meta text-muted-foreground">
                {busyBots.join(", ")} {busyBots.length === 1 ? "is" : "are"} working. The server restarts to update, and they pick their tasks back up after.
              </span>
            )}

            {disconnected && <span className="text-meta text-warning-foreground">Can't reach the server right now. Update once it's connected again.</span>}

            {status.error && <span className="text-meta text-destructive-foreground">{status.error}</span>}

            {mismatch && status.kind !== "working" && (
              <span className="flex items-start gap-2 text-meta text-warning-foreground">
                <TriangleAlert className="mt-px size-3.5 flex-none" aria-hidden />
                {mismatchText(mismatch)}
              </span>
            )}

            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-micro text-muted-foreground">{lastChecked && status.kind !== "working" && `Checked ${lastChecked}`}</span>
              <span className="flex flex-none gap-1.5">
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => {
                    now(false);
                    onOpenSettings();
                  }}
                >
                  Settings
                </Button>
                {status.action === "check" && (
                  <Button variant="outline" size="xs" className="px-2.5" onClick={act}>
                    Check now
                  </Button>
                )}
                {status.action === "install" && (
                  <Button size="xs" className="px-2.5" disabled={disconnected} onClick={act}>
                    {status.kind === "failed" ? "Try again" : status.plan.server && status.plan.app ? "Update both" : "Update"}
                  </Button>
                )}
              </span>
            </div>
          </div>
        </section>
      )}
    </span>
  );
}
