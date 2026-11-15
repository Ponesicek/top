/**
 * What the app says about updates without being asked, in the bottom-right corner: a newer version is
 * ready (Update or Later), the app and the server follow different channels, or one of them is too old
 * to work with the other. Nothing installs until the user presses Update.
 */
import { channelName } from "@top/client";
import { TriangleAlert, X } from "lucide-react";
import { type ReactNode, useState } from "react";
import { appUpdates } from "../bridge.ts";
import { top, useClient } from "../top.ts";
import { appActivity, dismiss, installBoth, mismatchText, serverActivity, useDismissed, useUpdates } from "../updates.ts";
import { Button } from "./ui/button.tsx";

function Card({ children, onClose }: { children: ReactNode; onClose?: (() => void) | undefined }) {
  return (
    <div role="status" className="relative flex w-90 max-w-full flex-col gap-2.5 rounded-2xl bg-popover px-4.5 py-4 shadow-popover">
      {onClose && (
        <Button variant="ghost" size="icon-xs" className="absolute top-2.5 right-2.5" aria-label="Dismiss" onClick={onClose}>
          <X className="size-3.5" />
        </Button>
      )}
      {children}
    </div>
  );
}

export function UpdatePopup({ onOpenSettings }: { onOpenSettings: () => void }) {
  const updates = useUpdates();
  const dismissed = useDismissed();
  const outdated = useClient((s) => s.outdated);
  const bots = useClient((s) => s.bots);
  const [error, setError] = useState<string>();
  const { server, app, mismatch } = updates;

  const serverOffer = server?.available && dismissed.server !== server.available.version ? server.available : undefined;
  const appOffer = app?.available && dismissed.app !== app.available.version ? app.available : undefined;
  const working =
    (server && server.state !== "idle" && server.state !== "failed") || (app && app.state !== "idle" && app.state !== "failed" && app.state !== "unavailable");
  const mismatchKey = mismatch && `${mismatch.app}:${mismatch.server}`;

  const cards: ReactNode[] = [];

  if (outdated) {
    const fix = outdated === "client" ? app?.available : server?.available;
    cards.push(
      <Card key="outdated">
        <div className="flex items-start gap-2.5">
          <TriangleAlert className="mt-0.5 size-4 flex-none text-warning-foreground" aria-hidden />
          <div className="flex flex-col gap-1">
            <strong className="text-small font-label">{outdated === "client" ? "Update this app" : "Update your server"}</strong>
            <span className="text-meta text-muted-foreground">
              {outdated === "client"
                ? "Your server was updated, and this version of the app can't work with it."
                : "This app is newer than your server, and can't work with it until the server is updated."}
            </span>
          </div>
        </div>
        <div className="flex justify-end gap-2">
          {fix ? (
            <Button
              size="wide"
              onClick={() =>
                (outdated === "client" ? appUpdates?.install() : top.installUpdate(fix.version))?.catch((e: unknown) =>
                  setError(String(e instanceof Error ? e.message : e)),
                )
              }
            >
              Update to {fix.version}
            </Button>
          ) : (
            <Button variant="outline" size="wide" onClick={onOpenSettings}>
              Open settings
            </Button>
          )}
        </div>
      </Card>,
    );
  } else if (serverOffer || appOffer || (working && (server?.available || app?.available))) {
    const versions = [
      serverOffer && `Server: ${server!.current} → ${serverOffer.version}`,
      appOffer && `This app: ${app!.version} → ${appOffer.version}`,
    ].filter(Boolean);
    const notes = [...new Set([...(serverOffer?.notes ?? []), ...(appOffer?.notes ?? [])])].slice(0, 5);
    const channel = server?.channel ?? app?.channel;
    const activity = serverActivity(server) ?? appActivity(app);
    const busyBots = bots.filter((b) => b.status === "thinking" || b.status === "tool" || b.status === "retrying").map((b) => b.name);
    cards.push(
      <Card
        key="update"
        onClose={
          working ? undefined : () => dismiss({ ...(serverOffer ? { server: serverOffer.version } : {}), ...(appOffer ? { app: appOffer.version } : {}) })
        }
      >
        <div className="flex items-center gap-2 pr-7">
          <strong className="text-small font-label">Update ready</strong>
          {channel && <span className="rounded-full bg-secondary px-2 py-0.5 text-micro text-secondary-foreground">{channelName(channel)}</span>}
        </div>
        <div className="flex flex-col font-mono text-[12px] text-secondary-foreground">
          {versions.map((v) => (
            <span key={v as string}>{v}</span>
          ))}
        </div>
        {notes.length > 0 && (
          <ul className="m-0 flex list-disc flex-col gap-0.5 pl-4.5 text-meta text-secondary-foreground">
            {notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        )}
        {serverOffer && busyBots.length > 0 && !working && (
          <span className="text-meta text-muted-foreground">
            {busyBots.join(", ")} {busyBots.length === 1 ? "is" : "are"} working. The server restarts to update, and they pick their tasks back up after.
          </span>
        )}
        {(error ?? activity) && (
          <span className={error || server?.state === "failed" ? "text-meta text-destructive-foreground" : "text-meta text-muted-foreground"}>
            {error ?? activity}
          </span>
        )}
        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            size="wide"
            disabled={!!working}
            onClick={() => dismiss({ ...(serverOffer ? { server: serverOffer.version } : {}), ...(appOffer ? { app: appOffer.version } : {}) })}
          >
            Later
          </Button>
          <Button
            size="wide"
            disabled={!!working}
            onClick={() => {
              setError(undefined);
              installBoth(updates).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
            }}
          >
            {working ? "Updating…" : "Update"}
          </Button>
        </div>
      </Card>,
    );
  }

  if (mismatch && mismatchKey !== dismissed.mismatch) {
    cards.push(
      <Card key="mismatch" onClose={() => mismatchKey && dismiss({ mismatch: mismatchKey })}>
        <div className="flex items-start gap-2.5 pr-7">
          <TriangleAlert className="mt-0.5 size-4 flex-none text-warning-foreground" aria-hidden />
          <div className="flex flex-col gap-1">
            <strong className="text-small font-label">Your app and server don't match</strong>
            <span className="text-meta text-muted-foreground">{mismatchText(mismatch)}</span>
          </div>
        </div>
        <div className="flex justify-end">
          <Button variant="outline" size="wide" onClick={onOpenSettings}>
            Choose in settings
          </Button>
        </div>
      </Card>,
    );
  }

  if (!cards.length) return null;
  return <div className="fixed right-4 bottom-4 z-40 flex max-w-[calc(100vw-2rem)] flex-col items-end gap-2.5">{cards}</div>;
}
