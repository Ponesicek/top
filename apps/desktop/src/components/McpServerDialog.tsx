import { useId, useRef, useState, type FormEvent } from "react";
import { X } from "lucide-react";
import { MAX_MCP_NAME, type McpSecret, type McpServerConfig, type McpServerView } from "@top/client";
import { joinCommand, splitCommand } from "../command.ts";
import { cn } from "../lib/utils.ts";
import { top } from "../top.ts";
import { messageOf } from "./BotDialogs.tsx";
import { Button } from "./ui/button.tsx";
import { Dialog, DialogBody, DialogClose, DialogDescription, DialogError, DialogFooter, DialogPopup, DialogTitle } from "./ui/dialog.tsx";
import { Field, FieldHint, FieldLabel, Input } from "./ui/field.tsx";

type Kind = McpServerConfig["transport"];

/** One variable or header being edited. `stored`: the daemon holds a value for this name, so an empty field keeps it. */
type SecretRow = { readonly key: number; name: string; value: string; readonly storedName?: string };

let nextKey = 1;
const rowsOf = (secrets: readonly McpSecret[]): SecretRow[] => secrets.map((s) => ({ key: nextKey++, name: s.name, value: "", storedName: s.name }));
const isStored = (row: SecretRow) => row.storedName !== undefined && row.storedName === row.name.trim();

/** What to send: a stored secret left empty goes without a value, which keeps it. */
const secretsOf = (rows: readonly SecretRow[]): McpSecret[] =>
  rows.filter((r) => r.name.trim()).map((r) => (isStored(r) && !r.value ? { name: r.name.trim() } : { name: r.name.trim(), value: r.value }));

function SecretList({
  label,
  hint,
  rows,
  onChange,
  namePlaceholder,
  valuePlaceholder,
  addLabel,
}: {
  label: string;
  hint: string;
  rows: SecretRow[];
  onChange: (rows: SecretRow[]) => void;
  namePlaceholder: string;
  valuePlaceholder: string;
  addLabel: string;
}) {
  const labelId = useId();
  const update = (key: number, change: Partial<SecretRow>) => onChange(rows.map((r) => (r.key === key ? { ...r, ...change } : r)));
  return (
    <div className="flex flex-col gap-1.5" role="group" aria-labelledby={labelId}>
      <span id={labelId} className="text-code leading-tight font-semibold text-secondary-foreground">
        {label} <FieldHint>{hint}</FieldHint>
      </span>
      {rows.map((row) => (
        <div key={row.key} className="flex items-center gap-1.5">
          <Input
            className="w-[42%] flex-none font-mono text-[13px]"
            value={row.name}
            placeholder={namePlaceholder}
            spellCheck={false}
            aria-label={`${label}: name`}
            onValueChange={(name) => update(row.key, { name })}
          />
          <Input
            className="min-w-0 flex-1 font-mono text-[13px]"
            type="password"
            autoComplete="off"
            value={row.value}
            placeholder={isStored(row) ? "Unchanged" : valuePlaceholder}
            aria-label={`${row.name || label}: value`}
            onValueChange={(value) => update(row.key, { value })}
          />
          <Button variant="ghost" size="icon-xs" className="flex-none" aria-label={`Remove ${row.name || "this row"}`} onClick={() => onChange(rows.filter((r) => r.key !== row.key))}>
            <X size={14} strokeWidth={2} />
          </Button>
        </div>
      ))}
      <Button variant="link" size="link" className="self-start" onClick={() => onChange([...rows, { key: nextKey++, name: "", value: "" }])}>
        {addLabel}
      </Button>
    </div>
  );
}

/** The form lives inside the popup, so it starts from the server's settings (or empty) each time. */
function McpServerForm({ server, onDone }: { server: McpServerView | undefined; onDone: () => void }) {
  const config = server?.config;
  const [name, setName] = useState(server?.name ?? "");
  const [kind, setKind] = useState<Kind>(config?.transport ?? "http");
  const [url, setUrl] = useState(config?.transport === "http" ? config.url : "");
  const [headers, setHeaders] = useState<SecretRow[]>(config?.transport === "http" ? rowsOf(config.headers) : []);
  const [commandLine, setCommandLine] = useState(config?.transport === "stdio" ? joinCommand([config.command, ...config.args]) : "");
  const [env, setEnv] = useState<SecretRow[]>(config?.transport === "stdio" ? rowsOf(config.env) : []);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const kindLabel = useId();

  const target = kind === "http" ? url.trim() : commandLine.trim();
  const ready = !!name.trim() && !!target;

  const act = async (run: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await run();
      onDone();
    } catch (err) {
      setError(messageOf(err));
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    const words = splitCommand(commandLine);
    const next: McpServerConfig =
      kind === "http"
        ? { transport: "http", url: url.trim(), headers: secretsOf(headers) }
        : { transport: "stdio", command: words[0] ?? "", args: words.slice(1), env: secretsOf(env) };
    void act(() => top.saveMcpServer(server?.id, name, next));
  };

  const hasAuthHeader = headers.some((h) => h.name.trim().toLowerCase() === "authorization");

  return (
    <form ref={form} onSubmit={submit}>
      <DialogBody>
        <DialogTitle>{server ? `Edit ${server.name}` : "Add MCP server"}</DialogTitle>
        {!server && <DialogDescription>Set it up once, then choose which bots get its tools.</DialogDescription>}
        <Field>
          <FieldLabel>Name</FieldLabel>
          <Input
            value={name}
            maxLength={MAX_MCP_NAME}
            placeholder="GitHub (work)"
            spellCheck={false}
            onValueChange={(value) => {
              setName(value);
              setError(undefined);
            }}
          />
        </Field>
        <div className="flex flex-col gap-1.5">
          <span id={kindLabel} className="text-code leading-tight font-semibold text-secondary-foreground">
            Connect with
          </span>
          <div role="radiogroup" aria-labelledby={kindLabel} className="flex gap-0.5 self-start rounded-field bg-secondary p-0.75">
            {(
              [
                { value: "http", label: "URL" },
                { value: "stdio", label: "Command" },
              ] as const
            ).map((o) => (
              <button
                key={o.value}
                type="button"
                role="radio"
                aria-checked={o.value === kind}
                onClick={() => setKind(o.value)}
                className={cn(
                  "rounded-[7px] px-3 py-1 text-meta font-label text-secondary-foreground transition-colors duration-120 hover:text-foreground",
                  o.value === kind && "bg-popover text-foreground shadow-row-selected",
                )}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
        {kind === "http" ? (
          <>
            <Field>
              <FieldLabel>URL</FieldLabel>
              <Input value={url} placeholder="https://mcp.example.com/mcp" spellCheck={false} className="font-mono text-[13px]" onValueChange={setUrl} />
            </Field>
            <SecretList
              label="Headers"
              hint={hasAuthHeader ? "optional" : "optional · without Authorization, you sign in when the server asks"}
              rows={headers}
              onChange={setHeaders}
              namePlaceholder="Authorization"
              valuePlaceholder="Bearer …"
              addLabel="Add header"
            />
          </>
        ) : (
          <>
            <Field>
              <FieldLabel>
                Command <FieldHint>runs on the daemon's computer</FieldHint>
              </FieldLabel>
              <Input value={commandLine} placeholder="npx -y @modelcontextprotocol/server-everything" spellCheck={false} className="font-mono text-[13px]" onValueChange={setCommandLine} />
            </Field>
            <SecretList
              label="Environment"
              hint="optional · put keys and tokens here"
              rows={env}
              onChange={setEnv}
              namePlaceholder="API_KEY"
              valuePlaceholder="value"
              addLabel="Add variable"
            />
          </>
        )}
        {server?.signedIn && (
          <div className="flex items-center justify-between gap-3 rounded-field bg-secondary px-3 py-2 text-meta text-secondary-foreground">
            <span>Signed in with OAuth. Sign out to use another account.</span>
            <Button variant="outline" size="xs" className="px-2.5" disabled={busy} onClick={() => void act(() => top.mcpSignOut(server.id))}>
              Sign out
            </Button>
          </div>
        )}
        {error && <DialogError>{error}</DialogError>}
        <DialogFooter className={cn(server && "justify-between")}>
          {server && (
            <Button
              variant={confirmDelete ? "destructive" : "ghost-destructive"}
              size="wide"
              disabled={busy}
              onClick={() => (confirmDelete ? void act(() => top.deleteMcpServer(server.id)) : setConfirmDelete(true))}
              onBlur={() => setConfirmDelete(false)}
            >
              {confirmDelete ? "Click again to remove" : "Remove"}
            </Button>
          )}
          <div className="flex gap-2">
            <DialogClose render={<Button variant="outline" size="wide" />}>Cancel</DialogClose>
            <Button type="submit" size="wide" disabled={busy || !ready}>
              {busy ? "Saving…" : server ? "Save" : "Add server"}
            </Button>
          </div>
        </DialogFooter>
      </DialogBody>
    </form>
  );
}

/** Add a server (`server` undefined) or edit one. */
export function McpServerDialog({ open, onOpenChange, server }: { open: boolean; onOpenChange: (open: boolean) => void; server: McpServerView | undefined }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="w-130">
        <McpServerForm key={server?.id ?? "new"} server={server} onDone={() => onOpenChange(false)} />
      </DialogPopup>
    </Dialog>
  );
}
