import { type BotId, CONTEXT_FILES, type ContextFileName, type ContextFileView, MAX_CONTEXT_FILE_BYTES } from "@top/client";
import { useCallback, useEffect, useId, useState } from "react";
import { cn } from "../lib/utils.ts";
import { top, useRoster } from "../top.ts";
import { messageOf } from "./BotDialogs.tsx";
import { BotChip, Section, Segmented } from "./SettingsSection.tsx";
import { Button } from "./ui/button.tsx";

const HINTS: Record<ContextFileName, string> = {
  "SOUL.md": "# Name\n\nWho the bot is: what it's for and how it comes across. The heading is its name in the app.",
  "AGENTS.md": "How it works: standing instructions, procedures and conventions for its tasks.",
  "USER.md": "About you: your preferences, and facts that help it help you.",
  "MEMORY.md": "What it has learned and will need again. It keeps this up to date itself.",
};
const OPTIONS = CONTEXT_FILES.map((name) => ({ value: name, label: name }));
const encoder = new TextEncoder();
const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;

function Editor({ bot, file, onSaved }: { bot: BotId; file: ContextFileView; onSaved: () => Promise<void> }) {
  const [draft, setDraft] = useState<string>();
  const [base, setBase] = useState(file.version);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const text = draft ?? file.content ?? "";
  const bytes = encoder.encode(text).length;
  const dirty = draft !== undefined && draft !== file.content;
  const stale = dirty && base !== file.version;

  useEffect(() => {
    if (draft === undefined) setBase(file.version);
  }, [draft, file.version]);

  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await top.saveContextFile(bot, file.name, text, stale ? file.version : base);
      await onSaved();
      setDraft(undefined);
    } catch (err) {
      setError(messageOf(err));
      await onSaved().catch(() => {});
    }
    setBusy(false);
  };

  return (
    <div className="flex flex-col gap-2">
      {file.error ? (
        <p className="m-0 rounded-field bg-secondary px-3 py-2.5 text-meta leading-normal text-destructive-foreground">
          {file.error} Open it in an editor, or ask the bot to fix it.
        </p>
      ) : (
        <textarea
          aria-label={file.name}
          value={text}
          placeholder={HINTS[file.name]}
          spellCheck={false}
          rows={12}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "s" && (e.ctrlKey || e.metaKey) && dirty) {
              e.preventDefault();
              void save();
            }
          }}
          className="max-h-[60vh] min-h-40 w-full resize-y rounded-field bg-background px-3 py-2.5 font-mono text-[12.5px] leading-relaxed text-foreground inset-ring inset-ring-input outline-none transition-shadow duration-90 placeholder:text-muted-foreground focus:inset-ring-primary focus:shadow-focus"
        />
      )}
      {(stale || error) && (
        <p className="m-0 text-meta leading-normal text-destructive-foreground">
          {stale ? "It changed since you started editing, maybe by the bot. Revert to see the new version, or replace it with yours." : error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted-foreground/80" title={file.path}>
          {file.path}
        </span>
        {!file.error && (
          <span className={cn("text-meta tabular-nums", bytes > MAX_CONTEXT_FILE_BYTES ? "text-destructive-foreground" : "text-muted-foreground")}>
            {kb(bytes)} of {kb(MAX_CONTEXT_FILE_BYTES)}
          </span>
        )}
        {dirty && (
          <Button
            variant="outline"
            size="xs"
            onClick={() => {
              setDraft(undefined);
              setError(undefined);
            }}
          >
            Revert
          </Button>
        )}
        {!file.error && (
          <Button size="xs" disabled={!dirty || busy || bytes > MAX_CONTEXT_FILE_BYTES} onClick={() => void save()}>
            {busy ? "Saving…" : stale ? "Replace it" : "Save"}
          </Button>
        )}
      </div>
    </div>
  );
}

export function BotContext() {
  const roster = useRoster();
  const [picked, setPicked] = useState<BotId>();
  const bot = roster.find((b) => b.id === picked) ?? roster[0];
  const [tab, setTab] = useState<ContextFileName>("SOUL.md");
  const [files, setFiles] = useState<{ bot: BotId; files: readonly ContextFileView[] }>();
  const [error, setError] = useState<string>();
  const label = useId();

  const load = useCallback(async (id: BotId) => {
    try {
      setFiles({ bot: id, files: await top.contextFiles(id) });
      setError(undefined);
    } catch (err) {
      setError(messageOf(err));
    }
  }, []);

  useEffect(() => {
    if (bot === undefined) return;
    void load(bot.id);
    const again = () => document.visibilityState === "visible" && void load(bot.id);
    window.addEventListener("focus", again);
    document.addEventListener("visibilitychange", again);
    return () => {
      window.removeEventListener("focus", again);
      document.removeEventListener("visibilitychange", again);
    };
  }, [bot, load]);

  if (!bot) return null;
  const shown = files?.bot === bot.id ? files.files : [];
  return (
    <Section title="Identity and memory">
      <div className="flex flex-col gap-3 px-4.5 py-3.5">
        <p className="m-0 text-meta leading-normal text-muted-foreground">
          Each bot keeps four Markdown files in its folder and has them with every message: who it is, how it works, what it knows about you, and what it has
          learned. You and the bot both edit them; a change reaches it from its next message. Keep secrets out of them.
        </p>
        {roster.length > 1 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {roster.map((b) => (
              <BotChip key={b.id} on={b.id === bot.id} onClick={() => setPicked(b.id)} title={`${b.name}'s files`}>
                {b.name}
              </BotChip>
            ))}
          </div>
        )}
        <div className="flex">
          <span id={label} className="sr-only">
            File
          </span>
          <Segmented value={tab} options={OPTIONS} onChange={setTab} labelledBy={label} />
        </div>
        {error && <p className="m-0 text-meta leading-normal text-destructive-foreground">{error}</p>}
        {shown.map((file) => (
          <div key={`${bot.id}:${file.name}`} hidden={file.name !== tab}>
            <Editor bot={bot.id} file={file} onSaved={() => load(bot.id)} />
          </div>
        ))}
      </div>
    </Section>
  );
}
