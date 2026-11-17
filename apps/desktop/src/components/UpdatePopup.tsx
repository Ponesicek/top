import { TriangleAlert } from "lucide-react";
import { useState } from "react";
import { useClient } from "../top.ts";
import { sources, useUpdates } from "../updates.ts";
import { Button } from "./ui/button.tsx";

export function UpdatePopup({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { server, app } = useUpdates();
  const outdated = useClient((s) => s.outdated);
  const [error, setError] = useState<string>();
  if (!outdated) return null;

  const fix = outdated === "client" ? app?.available : server?.available;
  const install = outdated === "client" ? sources.installApp : fix ? () => sources.installServer(fix.version) : undefined;
  return (
    <div className="fixed right-4 bottom-4 z-40 flex max-w-[calc(100vw-2rem)] flex-col items-end gap-2.5">
      <div role="status" className="relative flex w-90 max-w-full flex-col gap-2.5 rounded-2xl bg-popover px-4.5 py-4 shadow-popover">
        <div className="flex items-start gap-2.5">
          <TriangleAlert className="mt-0.5 size-4 flex-none text-warning-foreground" aria-hidden />
          <div className="flex flex-col gap-1">
            <strong className="text-small font-label">{outdated === "client" ? "Update this app" : "Update your server"}</strong>
            <span className="text-meta text-muted-foreground">
              {outdated === "client"
                ? "Your server was updated, and this version of the app can't work with it."
                : "This app is newer than your server, and can't work with it until the server is updated."}
            </span>
            {error && <span className="text-meta text-destructive-foreground">{error}</span>}
          </div>
        </div>
        <div className="flex justify-end gap-2">
          {fix && install ? (
            <Button
              size="wide"
              onClick={() => {
                setError(undefined);
                install().catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
              }}
            >
              Update to {fix.version}
            </Button>
          ) : (
            <Button variant="outline" size="wide" onClick={onOpenSettings}>
              Open settings
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
