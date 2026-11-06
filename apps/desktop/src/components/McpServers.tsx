import type { BotId, McpServerView } from "@top/client";
import { Plus } from "lucide-react";
import { useRef, useState, useSyncExternalStore } from "react";
import { joinCommand } from "../command.ts";
import { cn } from "../lib/utils.ts";
import { serverUrl, top, useRoster } from "../top.ts";
import { messageOf } from "./BotDialogs.tsx";
import { McpServerDialog } from "./McpServerDialog.tsx";
import { Section } from "./SettingsSection.tsx";
import { Button } from "./ui/button.tsx";

const STATE_DOT: Record<McpServerView["state"], string> = {
  ready: "bg-success",
  connecting: "bg-warning animate-pulse motion-reduce:animate-none",
  signin: "bg-info",
  failed: "bg-destructive",
};

/** The daemon runs elsewhere: a sign-in redirect lands on its computer, not this one. */
const remoteDaemon = (() => {
  try {
    return !["127.0.0.1", "localhost", "[::1]"].includes(new URL(serverUrl).hostname);
  } catch {
    return false;
  }
})();

function where(server: McpServerView): string {
  const config = server.config;
  if (config.transport === "stdio") return joinCommand([config.command.split(/[\\/]/).pop() || config.command, ...config.args]);
  try {
    const url = new URL(config.url);
    return url.host + (url.pathname === "/" ? "" : url.pathname);
  } catch {
    return config.url;
  }
}

function stateLine(server: McpServerView): string {
  switch (server.state) {
    case "ready":
      return server.tools.length === 1 ? "1 tool" : `${server.tools.length} tools`;
    case "connecting":
      return "Connecting…";
    case "signin":
      return "Needs you to sign in";
    case "failed":
      return "Can't connect";
  }
}

/** A bot's toggle: on means the bot gets this server's tools. Flips at once; the daemon's answer settles it. */
function BotToggle({ server, bot, name }: { server: McpServerView; bot: BotId; name: string }) {
  const [pending, setPending] = useState<boolean>();
  const on = pending ?? server.bots.includes(bot);
  const toggle = async () => {
    const next = !on;
    setPending(next);
    try {
      await top.assignMcp(server.id, bot, next);
    } catch {
      // Not applied: show what the daemon has.
    }
    setPending(undefined);
  };
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={() => void toggle()}
      title={on ? `${name} has ${server.name}'s tools. Click to take them away.` : `Give ${name} ${server.name}'s tools`}
      className={cn(
        "inline-flex h-6.5 items-center gap-1.5 rounded-full px-2.5 text-meta leading-none font-label transition-colors duration-90 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
        on ? "bg-primary-soft text-link inset-ring inset-ring-primary/35" : "bg-secondary text-muted-foreground hover:text-foreground",
      )}
    >
      <i className={cn("size-1.5 rounded-full", on ? "bg-primary" : "inset-ring-[1.5px] inset-ring-current")} aria-hidden />
      {name}
    </button>
  );
}

function ServerRow({ server, bots, onEdit }: { server: McpServerView; bots: readonly { id: BotId; name: string }[]; onEdit: () => void }) {
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const act = async (run: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await run();
    } catch (err) {
      setError(messageOf(err));
    }
    setBusy(false);
  };
  const signIn = () =>
    act(async () => {
      const url = await top.mcpSignIn(server.id);
      window.open(url, "_blank", "noopener");
    });
  const problem = error ?? (server.state === "failed" || server.state === "signin" ? server.error : undefined);
  return (
    <div className="flex flex-col gap-3 px-4.5 py-3.5">
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-2">
            <i className={cn("size-1.75 flex-none rounded-full", STATE_DOT[server.state])} aria-hidden />
            <span className="truncate text-small leading-snug font-label">{server.name}</span>
          </span>
          <span className="truncate pl-3.75 text-meta text-muted-foreground" title={server.state === "ready" ? server.tools.join(", ") : undefined}>
            <span className="font-mono text-[11.5px]">{where(server)}</span> · {stateLine(server)}
          </span>
        </div>
        <div className="flex flex-none items-center gap-1.5">
          {server.state === "signin" && (
            <Button size="xs" className="px-2.5" disabled={busy} onClick={() => void signIn()}>
              Sign in
            </Button>
          )}
          {server.state === "failed" && (
            <Button variant="outline" size="xs" className="px-2.5" disabled={busy} onClick={() => void act(() => top.mcpRetry(server.id))}>
              Retry
            </Button>
          )}
          <Button variant="ghost" size="xs" className="px-2.5" onClick={onEdit}>
            Edit
          </Button>
        </div>
      </div>
      {problem && (
        <p className="m-0 line-clamp-3 pl-3.75 font-mono text-[11.5px] leading-normal whitespace-pre-wrap text-destructive-foreground" title={problem}>
          {problem}
        </p>
      )}
      {server.state === "signin" && remoteDaemon && (
        <p className="m-0 pl-3.75 text-meta text-muted-foreground">Signing in finishes in a browser on the daemon's computer, so start it from there.</p>
      )}
      <div className="flex flex-wrap items-center gap-1.5 pl-3.75">
        {bots.length === 0 ? (
          <span className="text-meta text-muted-foreground">Make a bot to give it these tools.</span>
        ) : (
          bots.map((bot) => <BotToggle key={bot.id} server={server} bot={bot.id} name={bot.name} />)
        )}
      </div>
    </div>
  );
}

/** The MCP servers on the daemon, and which bots use each. A bot starts with none. */
export function McpServers() {
  const servers = useSyncExternalStore(top.subscribe, () => top.getSnapshot().mcpServers);
  // Only names and ids: they don't change when a bot's status does.
  const bots = useRoster();
  const [editing, setEditing] = useState<number | "new">();
  const [open, setOpen] = useState(false);
  // Live while the dialog is open (state and tools change); the last one seen while it animates out
  // after a removal, so it doesn't flip to "Add" on its way out.
  const last = useRef<McpServerView>(undefined);
  const live = typeof editing === "number" ? servers.find((s) => s.id === editing) : undefined;
  if (live) last.current = live;
  const editingServer = editing === "new" ? undefined : (live ?? last.current);
  const openEditor = (id: number | "new") => {
    setEditing(id);
    setOpen(true);
  };

  return (
    <>
      <Section
        title="MCP servers"
        action={
          <Button variant="link" size="link" onClick={() => openEditor("new")}>
            <Plus size={13} strokeWidth={2.2} />
            Add server
          </Button>
        }
      >
        {servers.length === 0 ? (
          <p className="m-0 px-4.5 py-3.5 text-meta text-muted-foreground">
            Give bots tools from other apps and services. Each bot gets only the servers you choose.
          </p>
        ) : (
          servers.map((server) => <ServerRow key={server.id} server={server} bots={bots} onEdit={() => openEditor(server.id)} />)
        )}
      </Section>
      <McpServerDialog open={open} onOpenChange={setOpen} server={editingServer} />
    </>
  );
}
