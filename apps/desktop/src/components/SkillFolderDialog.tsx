import type { BotId, SkillFolder, SkillFolderAdded, SkillFolderEntry } from "@top/client";
import { type FormEvent, useState } from "react";
import { cn } from "../lib/utils.ts";
import { top, useRoster } from "../top.ts";
import { messageOf } from "./BotDialogs.tsx";
import { BotChip } from "./SettingsSection.tsx";
import { Button } from "./ui/button.tsx";
import { Dialog, DialogBody, DialogClose, DialogDescription, DialogError, DialogFooter, DialogPopup, DialogTitle } from "./ui/dialog.tsx";
import { Field, FieldHint, FieldLabel, Input } from "./ui/field.tsx";

const STATE: Record<SkillFolderEntry["state"], { label: string; className: string }> = {
  new: { label: "New", className: "bg-primary-soft text-link" },
  added: { label: "Added already", className: "bg-secondary text-secondary-foreground" },
  taken: { label: "Name taken", className: "bg-destructive-surface text-destructive-foreground" },
  broken: { label: "Can't be used", className: "bg-destructive-surface text-destructive-foreground" },
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function Summary({ preview }: { preview: SkillFolder }) {
  const count = (state: SkillFolderEntry["state"]) => preview.skills.filter((s) => s.state === state).length;
  const manual = preview.skills.filter((s) => s.skill.manual && (s.state === "new" || s.state === "added")).length;
  const parts = [
    count("new") && `${count("new")} to add`,
    count("added") && `${count("added")} added already`,
    count("taken") && `${count("taken")} whose name is taken`,
    count("broken") && `${count("broken")} that can't be used`,
  ].filter(Boolean);
  return (
    <p className="m-0 text-meta leading-normal text-secondary-foreground">
      {plural(preview.skills.length, "skill")}: {parts.join(", ")}.
      {manual > 0 &&
        ` ${manual} ${manual === 1 ? "is" : "are"} only for when you ask with /name: bots aren't told about ${manual === 1 ? "it" : "them"} otherwise.`}
    </p>
  );
}

function Found({ preview }: { preview: SkillFolder }) {
  return (
    <ul className="m-0 flex max-h-56 list-none flex-col divide-y overflow-y-auto rounded-field p-0 inset-ring inset-ring-border">
      {preview.skills.map(({ skill, state, reason }) => (
        <li key={skill.name} className="flex flex-col gap-0.5 px-3 py-2">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate font-mono text-[12.5px]">{skill.name}</span>
            <span className={cn("flex-none rounded-md px-1.5 py-0.5 text-micro leading-none font-label", STATE[state].className)}>{STATE[state].label}</span>
            {skill.manual && <span className="flex-none text-micro text-muted-foreground">only when asked</span>}
          </span>
          {reason && <span className="text-meta leading-snug text-destructive-foreground">{reason}</span>}
        </li>
      ))}
    </ul>
  );
}

function Result({ result }: { result: SkillFolderAdded }) {
  const bots = useRoster();
  const nameOf = (id: BotId) => bots.find((b) => b.id === id)?.name ?? "a deleted bot";
  return (
    <div className="flex flex-col gap-2 text-meta leading-normal text-secondary-foreground">
      <p className="m-0">
        {result.added.length ? `Added ${plural(result.added.length, "skill")} to the shared library.` : "No new skills were added."}
        {result.enabled
          .filter((e) => e.names.length)
          .map((e) => ` Switched ${plural(e.names.length, "skill")} on for ${nameOf(e.bot)}.`)
          .join("")}
      </p>
      {result.skipped.length > 0 && (
        <ul className="m-0 flex max-h-40 list-none flex-col gap-1 overflow-y-auto p-0">
          {result.skipped.map((s, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: one name can be left out for more than one reason
            <li key={i}>
              <span className="font-mono text-[12px]">{s.name}</span>: {s.reason}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SkillFolderForm({ onDone }: { onDone: () => void }) {
  const bots = useRoster();
  const [folder, setFolder] = useState("");
  const [preview, setPreview] = useState<SkillFolder>();
  const [chosen, setChosen] = useState<ReadonlySet<BotId>>(new Set());
  const [result, setResult] = useState<SkillFolderAdded>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const count = (...states: SkillFolderEntry["state"][]) => preview?.skills.filter((s) => states.includes(s.state)).length ?? 0;
  const fresh = count("new");
  const usable = count("new", "added");
  const action = !preview
    ? "Find skills"
    : fresh
      ? `Add ${plural(fresh, "skill")}`
      : chosen.size && usable
        ? `Switch on ${plural(usable, "skill")}`
        : undefined;

  const run = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await work();
    } catch (err) {
      setError(messageOf(err));
    }
    setBusy(false);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (result) return onDone();
    if (!folder.trim()) return;
    if (!preview) return void run(async () => setPreview(await top.previewSkillFolder(folder)));
    if (action) void run(async () => setResult(await top.addSkillFolder(preview.folder, [...chosen])));
  };

  const toggle = (bot: BotId) =>
    setChosen((was) => {
      const next = new Set(was);
      if (!next.delete(bot)) next.add(bot);
      return next;
    });

  return (
    <form onSubmit={submit}>
      <DialogBody>
        <DialogTitle>Add skills from a folder</DialogTitle>
        <DialogDescription>
          A folder of skill folders, such as a cloned repository's <span className="font-mono text-[13px]">skills/</span>, or one skill's folder. Each skill is
          linked into the shared library, so its files stay where they are and an update to them reaches every bot. Nothing is copied, replaced or run.
        </DialogDescription>
        <Field>
          <FieldLabel>
            Folder <FieldHint>on the daemon's computer</FieldHint>
          </FieldLabel>
          <Input
            value={folder}
            placeholder="~/src/my-skills/skills"
            spellCheck={false}
            autoFocus
            disabled={!!result}
            className="font-mono text-[13px]"
            onValueChange={(value) => {
              setFolder(value);
              setPreview(undefined);
              setError(undefined);
            }}
          />
        </Field>
        {preview && !result && (
          <>
            {preview.skills.length === 0 ? (
              <p className="m-0 text-meta text-secondary-foreground">There are no skills in {preview.folder}: a skill is a folder with a SKILL.md.</p>
            ) : (
              <>
                <Summary preview={preview} />
                <Found preview={preview} />
              </>
            )}
            {usable > 0 && bots.length > 0 && (
              // biome-ignore lint/a11y/useSemanticElements: a <fieldset> brings its own layout quirks; role="group" names the chips just as well
              <div className="flex flex-col gap-1.5" role="group" aria-label="Switch them on for">
                <span className="text-code leading-tight font-semibold text-secondary-foreground">
                  Switch them on for <FieldHint>optional · or later, under Skills</FieldHint>
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {bots.map((bot) => (
                    <BotChip
                      key={bot.id}
                      on={chosen.has(bot.id)}
                      title={chosen.has(bot.id) ? `Don't switch them on for ${bot.name}` : `Switch them on for ${bot.name}`}
                      onClick={() => toggle(bot.id)}
                    >
                      {bot.name}
                    </BotChip>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
        {result && <Result result={result} />}
        {error && <DialogError>{error}</DialogError>}
        <DialogFooter>
          {result ? (
            <Button type="submit" size="wide">
              Done
            </Button>
          ) : (
            <>
              <DialogClose render={<Button variant="outline" size="wide" />}>Cancel</DialogClose>
              <Button type="submit" size="wide" disabled={busy || !folder.trim() || !action}>
                {busy ? (preview ? "Adding…" : "Looking…") : (action ?? "Nothing to add")}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogBody>
    </form>
  );
}

/** `session` changes each time it opens, so it starts empty without clearing while it closes. */
export function SkillFolderDialog({ open, session, onOpenChange }: { open: boolean; session: number; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="w-130">
        <SkillFolderForm key={session} onDone={() => onOpenChange(false)} />
      </DialogPopup>
    </Dialog>
  );
}
