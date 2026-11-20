import type { BotId, BotSkills, SkillsView, SkillView } from "@top/client";
import { ChevronRight, Plus, RefreshCw } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { cn } from "../lib/utils.ts";
import { type RosterBot, top, useClient, useRoster } from "../top.ts";
import { messageOf } from "./BotDialogs.tsx";
import { BotChip, Section } from "./SettingsSection.tsx";
import { SkillFolderDialog } from "./SkillFolderDialog.tsx";
import { Button } from "./ui/button.tsx";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "./ui/collapsible.tsx";

const PATH = "font-mono text-[11.5px]";

function BotToggle({
  bot,
  names,
  on,
  disabled,
  title,
  onError,
  children,
}: {
  bot: RosterBot;
  names: readonly string[];
  on: boolean;
  disabled?: boolean;
  title: string;
  onError: (error: string) => void;
  children?: ReactNode;
}) {
  const [pending, setPending] = useState<boolean>();
  const shown = pending ?? on;
  const toggle = async () => {
    const next = !shown;
    setPending(next);
    try {
      await top.enableSkills(bot.id, names, next);
    } catch (err) {
      onError(messageOf(err));
    }
    setPending(undefined);
  };
  return (
    <BotChip on={shown} disabled={disabled} onClick={() => void toggle()} title={title}>
      {children ?? bot.name}
    </BotChip>
  );
}

function Shadowed({ bot, name }: { bot: RosterBot; name: string }) {
  return (
    <span
      className="inline-flex h-6.5 items-center gap-1.5 rounded-full border border-dashed px-2.5 text-meta leading-none font-label text-muted-foreground"
      title={`${bot.name} has its own ${name} skill, which it uses instead of this one. Switch it on or off under ${bot.name}'s own skills.`}
    >
      {bot.name} · own copy
    </span>
  );
}

function SkillRow({
  skill,
  badge,
  children,
}: {
  skill: Pick<SkillView, "name" | "description" | "path" | "error" | "manual">;
  badge?: ReactNode;
  children: (onError: (e: string) => void) => ReactNode;
}) {
  const [error, setError] = useState<string>();
  const problem = error ?? skill.error;
  return (
    <div className="flex flex-col gap-2.5 px-4.5 py-3.5">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-small leading-snug font-label">{skill.name}</span>
          {badge}
          {skill.manual && (
            <Tag
              title={`Its frontmatter says disable-model-invocation: a bot that has it isn't told about it, and uses it only when a message starts with /${skill.name}.`}
            >
              Only when asked
            </Tag>
          )}
        </span>
        {skill.description && <span className="line-clamp-2 text-meta text-muted-foreground">{skill.description}</span>}
        {skill.path && (
          <span className={cn(PATH, "truncate text-muted-foreground/80")} title={skill.path}>
            {skill.path}
          </span>
        )}
      </div>
      {problem && (
        <p className="m-0 line-clamp-3 text-meta leading-normal text-destructive-foreground" title={problem}>
          {problem}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-1.5">{children(setError)}</div>
    </div>
  );
}

function Tag({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span className="flex-none rounded-md bg-secondary px-1.5 py-0.5 text-micro leading-none font-label text-secondary-foreground" title={title}>
      {children}
    </span>
  );
}

const toggleTitle = (bot: RosterBot, name: string, on: boolean, error: string | undefined) =>
  error && !on ? `${name} can't be used, so it can't be switched on` : on ? `${bot.name} has ${name}. Click to take it away.` : `Give ${bot.name} ${name}`;

function SharedSkillRow({ skill, bots, ofBot }: { skill: SkillView; bots: readonly RosterBot[]; ofBot: (bot: BotId) => BotSkills | undefined }) {
  return (
    <SkillRow skill={skill} badge={<Tag title="In the shared library: every bot that has it uses these files">Shared</Tag>}>
      {(onError) =>
        bots.length === 0 ? (
          <span className="text-meta text-muted-foreground">Make a bot to give it this skill.</span>
        ) : (
          bots.map((bot) => {
            const mine = ofBot(bot.id);
            if (mine?.local.some((s) => s.name === skill.name)) return <Shadowed key={bot.id} bot={bot} name={skill.name} />;
            const on = mine?.enabled.includes(skill.name) ?? false;
            return (
              <BotToggle
                key={bot.id}
                bot={bot}
                names={[skill.name]}
                on={on}
                disabled={!!skill.error && !on}
                title={toggleTitle(bot, skill.name, on, skill.error)}
                onError={onError}
              />
            );
          })
        )
      }
    </SkillRow>
  );
}

/** Shared skills linked in from one folder: switched on or off for a bot all at once, listed one by one when opened. */
function SkillPack({
  folder,
  skills,
  bots,
  ofBot,
}: {
  folder: string;
  skills: readonly SkillView[];
  bots: readonly RosterBot[];
  ofBot: (bot: BotId) => BotSkills | undefined;
}) {
  const [error, setError] = useState<string>();
  const manual = skills.filter((s) => s.manual && !s.error).length;
  const broken = skills.filter((s) => s.error).length;
  const details = [`${skills.length} skills`, manual && `${manual} only when asked`, broken && `${broken} can't be used`].filter(Boolean).join(" · ");
  return (
    <Collapsible className="flex flex-col">
      <div className="flex flex-col gap-2.5 px-4.5 py-3.5">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-2">
            <span className={cn(PATH, "truncate text-small leading-snug")} title={folder}>
              {folder}
            </span>
            <Tag title="Linked into the shared library from this folder: its files stay there">Linked</Tag>
          </span>
          <span className="text-meta text-muted-foreground">{details}</span>
        </div>
        {error && <p className="m-0 line-clamp-3 text-meta leading-normal text-destructive-foreground">{error}</p>}
        <div className="flex flex-wrap items-center gap-1.5">
          {bots.length === 0 ? (
            <span className="text-meta text-muted-foreground">Make a bot to give it these skills.</span>
          ) : (
            bots.map((bot) => {
              const mine = ofBot(bot.id);
              // A bot's own skill with one of these names stays as it is: switching the name on or off would switch its own.
              const theirs = skills.filter((s) => !mine?.local.some((l) => l.name === s.name));
              const names = theirs.filter((s) => !s.error).map((s) => s.name);
              const has = names.filter((name) => mine?.enabled.includes(name)).length;
              const all = names.length > 0 && has === names.length;
              return (
                <BotToggle
                  key={bot.id}
                  bot={bot}
                  // Off takes the broken ones too, so none stays on unseen.
                  names={all ? theirs.map((s) => s.name) : names}
                  on={all}
                  disabled={names.length === 0}
                  title={all ? `${bot.name} has all ${names.length}. Click to take them away.` : `Give ${bot.name} all ${names.length}`}
                  onError={setError}
                >
                  <span>
                    {bot.name}
                    {has > 0 && !all && <span className="text-muted-foreground">{` · ${has} of ${names.length}`}</span>}
                  </span>
                </BotToggle>
              );
            })
          )}
        </div>
        <CollapsibleTrigger
          render={<Button variant="link" size="link" className="group self-start" />}
          nativeButton
          className="text-muted-foreground not-disabled:hover:text-foreground"
        >
          <ChevronRight size={12.5} strokeWidth={2.2} className="transition-transform duration-120 group-data-panel-open:rotate-90" />
          One by one
        </CollapsibleTrigger>
      </div>
      <CollapsiblePanel className="flex flex-col divide-y border-t">
        {skills.map((skill) => (
          <SharedSkillRow key={skill.name} skill={skill} bots={bots} ofBot={ofBot} />
        ))}
      </CollapsiblePanel>
    </Collapsible>
  );
}

/** Shared skills grouped by the folder they're linked from; a folder with one skill in the library isn't a group. */
function packsOf(view: SkillsView) {
  const byFolder = new Map<string, SkillView[]>();
  for (const skill of view.shared) if (skill.linkedFrom) byFolder.set(skill.linkedFrom, [...(byFolder.get(skill.linkedFrom) ?? []), skill]);
  const packs = [...byFolder].filter(([, skills]) => skills.length > 1);
  const grouped = new Set(packs.flatMap(([, skills]) => skills));
  return { packs, loose: view.shared.filter((skill) => !grouped.has(skill)) };
}

export function Skills() {
  const view = useClient((snapshot) => snapshot.skills);
  const bots = useRoster();
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string>();
  const [adding, setAdding] = useState(false);
  const [session, setSession] = useState(0);
  const refresh = async () => {
    setRefreshing(true);
    setRefreshError(undefined);
    try {
      await top.rescanSkills();
    } catch (err) {
      setRefreshError(messageOf(err));
    }
    setRefreshing(false);
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per opening
  useEffect(() => {
    if (view) void refresh();
  }, [view === undefined]);
  if (!view) return null;

  const byId = new Map<BotId, RosterBot>(bots.map((b) => [b.id, b]));
  const ofBot = (bot: BotId) => view.bots.find((b) => b.bot === bot);
  const own = view.bots.flatMap((b) => {
    const bot = byId.get(b.bot);
    return bot ? b.local.map((skill) => ({ bot, skill, enabled: b.enabled.includes(skill.name) })) : [];
  });
  const missing = view.bots.flatMap((b) => {
    const bot = byId.get(b.bot);
    if (!bot) return [];
    return b.enabled.filter((name) => !b.local.some((s) => s.name === name) && !view.shared.some((s) => s.name === name)).map((name) => ({ bot, name }));
  });
  const { packs, loose } = packsOf(view);
  const empty = view.shared.length === 0 && own.length === 0 && missing.length === 0;

  return (
    <>
      <Section
        title="Skills"
        action={
          <span className="flex items-center gap-4">
            <Button
              variant="link"
              size="link"
              onClick={() => {
                setSession((n) => n + 1);
                setAdding(true);
              }}
            >
              <Plus size={13} strokeWidth={2.2} />
              Add from folder
            </Button>
            <Button variant="link" size="link" disabled={refreshing} onClick={() => void refresh()}>
              <RefreshCw size={12.5} strokeWidth={2.2} className={cn(refreshing && "animate-spin motion-reduce:animate-none")} />
              Rescan
            </Button>
          </span>
        }
      >
        {refreshError && <p className="m-0 px-4.5 py-3.5 text-meta leading-normal text-destructive-foreground">{refreshError}</p>}
        {empty && (
          <p className="m-0 px-4.5 py-3.5 text-meta text-muted-foreground">
            No skills yet. Add a folder, or put one in <span className={cn(PATH, "break-all")}>{view.library}</span> and press Rescan.
          </p>
        )}
        {packs.map(([folder, skills]) => (
          <SkillPack key={`pack:${folder}`} folder={folder} skills={skills} bots={bots} ofBot={ofBot} />
        ))}
        {loose.map((skill) => (
          <SharedSkillRow key={`shared:${skill.name}`} skill={skill} bots={bots} ofBot={ofBot} />
        ))}
        {own.map(({ bot, skill, enabled }) => {
          const replaces = view.shared.some((s) => s.name === skill.name);
          return (
            <SkillRow
              key={`local:${bot.id}:${skill.name}`}
              skill={skill}
              badge={
                <Tag title={`In ${bot.name}'s own folder: only ${bot.name} can use it${replaces ? ", in place of the shared one" : ""}`}>
                  {bot.name}'s own{replaces ? " · replaces shared" : ""}
                </Tag>
              }
            >
              {(onError) => (
                <BotToggle
                  bot={bot}
                  names={[skill.name]}
                  on={enabled}
                  disabled={!!skill.error && !enabled}
                  title={toggleTitle(bot, skill.name, enabled, skill.error)}
                  onError={onError}
                />
              )}
            </SkillRow>
          );
        })}
        {missing.map(({ bot, name }) => (
          <SkillRow
            key={`missing:${bot.id}:${name}`}
            skill={{
              name,
              description: "",
              path: "",
              error: `Switched on for ${bot.name}, but there's no skill by this name anymore. Switch it off, or put it back.`,
            }}
          >
            {(onError) => <BotToggle bot={bot} names={[name]} on title={`Switch ${name} off for ${bot.name}`} onError={onError} />}
          </SkillRow>
        ))}
      </Section>
      <SkillFolderDialog open={adding} session={session} onOpenChange={setAdding} />
    </>
  );
}
