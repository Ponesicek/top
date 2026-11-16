/**
 * Settings → Updates: which releases the server and this app follow, what each runs, and updating
 * either now. They have a channel each, since one server serves many devices.
 */
import { CHANNELS, type Channel, channelName } from "@top/client";
import { TriangleAlert } from "lucide-react";
import { useState } from "react";
import { appUpdates } from "../bridge.ts";
import { top } from "../top.ts";
import { appActivity, checkBoth, mismatchText, serverActivity, sources, useAgo, useUpdates } from "../updates.ts";
import { Row, Section, Segmented } from "./SettingsSection.tsx";
import { Button } from "./ui/button.tsx";

const CHANNEL_OPTIONS = CHANNELS.map((value) => ({ value, label: channelName(value) }));

export function UpdateSettings() {
  const updates = useUpdates();
  const { server, app, mismatch } = updates;
  const [error, setError] = useState<string>();
  const checking = server?.state === "checking" || app?.state === "checking";
  const lastChecked = useAgo(Math.max(server?.checkedAt ?? 0, app?.checkedAt ?? 0) || undefined);
  const updatable = !!server || (app !== undefined && app.state !== "unavailable");

  const act = (run: () => Promise<unknown>) => {
    setError(undefined);
    run().catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  const serverDescription = server
    ? [
        `Top ${server.current}`,
        server.available ? `Top ${server.available.version} is available` : server.checkedAt ? "Up to date" : undefined,
        serverActivity(server),
      ]
    : [
        updates.serverVersion ? `Top ${updates.serverVersion}` : undefined,
        updates.serverChannel
          ? "Install it with `top install` to update it from here."
          : updates.serverVersion
            ? "Runs from a checkout of Top's code: update it with git pull."
            : undefined,
      ];
  const appDescription = app
    ? [
        `Top ${app.version}`,
        app.available ? `Top ${app.available.version} is available` : app.checkedAt ? "Up to date" : undefined,
        app.state === "unavailable" ? "Runs from a checkout of Top's code: update it with git pull." : appActivity(app),
      ]
    : [];

  return (
    <Section
      title="Updates"
      action={
        updatable && (
          <span className="flex items-center gap-2 text-micro text-muted-foreground">
            {lastChecked && `Checked ${lastChecked}`}
            <Button variant="ghost" size="xs" disabled={checking} onClick={() => act(() => checkBoth(updates))}>
              {checking ? "Checking…" : "Check now"}
            </Button>
          </span>
        )
      }
    >
      <Row
        label="Server"
        description={serverDescription.filter(Boolean).join(" · ") || "Not connected"}
        control={({ labelId }) => (
          <span className="flex flex-none items-center gap-2">
            {server?.available && (
              <Button
                size="xs"
                className="px-2.5"
                disabled={server.state !== "idle" && server.state !== "failed"}
                onClick={() => act(() => sources.installServer(server.available!.version))}
              >
                Update
              </Button>
            )}
            {server && (
              <Segmented<Channel> value={server.channel} options={CHANNEL_OPTIONS} onChange={(c) => act(() => top.setUpdateChannel(c))} labelledBy={labelId} />
            )}
          </span>
        )}
      />
      {app && (
        <Row
          label="This app"
          description={appDescription.filter(Boolean).join(" · ")}
          control={({ labelId }) => (
            <span className="flex flex-none items-center gap-2">
              {app.available && (
                <Button size="xs" className="px-2.5" disabled={app.state !== "idle" && app.state !== "failed"} onClick={() => act(() => sources.installApp!())}>
                  Update
                </Button>
              )}
              {app.channel && app.state !== "unavailable" && (
                <Segmented<Channel> value={app.channel} options={CHANNEL_OPTIONS} onChange={(c) => act(() => appUpdates!.setChannel(c))} labelledBy={labelId} />
              )}
            </span>
          )}
        />
      )}
      {(mismatch || error) && (
        <div className="flex items-start gap-2.5 px-4.5 py-3.5 text-meta text-warning-foreground">
          <TriangleAlert className="mt-px size-4 flex-none" aria-hidden />
          <span>{error ?? `${mismatchText(mismatch!)} Pick the same updates for both.`}</span>
        </div>
      )}
    </Section>
  );
}
