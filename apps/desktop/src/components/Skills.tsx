/**
 * Settings → Skills: what the daemon found in the shared library and in each bot's own folder, and
 * which bots have which. Nothing here installs or edits a skill: they are folders on the daemon's
 * computer, and a bot uses only the ones switched on for it (a new bot has none).
 */
import type { BotId, SkillView } from "@top/client";
import { RefreshCw } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { cn } from "../lib/utils.ts";
import { type RosterBot, top, useClient, useRoster } from "../top.ts";
import { messageOf } from "./BotDialogs.tsx";
import { BotChip, Section } from "./SettingsSection.tsx";
import { Button } from "./ui/button.tsx";

const PATH = "font-mono text-[11.5px]";

/** A bot's chip on a skill: on means the bot has it. Flips at once; the daemon's answer settles it. */
function BotToggle({
  bot,
  name,
  on,
  disabled,
  title,
  onError,
}: {
  bot: RosterBot;
  name: string;
  on: boolean;
  disabled?: boolean;
  title: string;
  onError: (error: string) => void;
}) {
  const [pending, setPending] = useState<boolean>();
  const shown = pending ?? on;
  const toggle = async () => {
    const next = !shown;
    setPending(next);
    try {
      await top.enableSkill(bot.id, name, next);
    } catch (err) {
      onError(messageOf(err));
    }
    setPending(undefined);
  };
  return (
    <BotChip on={shown} disabled={disabled} onClick={() => void toggle()} title={title}>
      {bot.name}
    </BotChip>
  );
}

/** A chip that isn't a switch: the bot has a skill of its own by this name, which takes this one's place. */
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
  skill: Pick<SkillView, "name" | "description" | "path" | "error">;
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

/** The skills on the daemon, and which bots use each. A bot starts with none. */
export function Skills() {
  const view = useClient((snapshot) => snapshot.skills);
  // Only names and ids: they don't change when a bot's status does.
  const bots = useRoster();
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string>();
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
  // Skills are folders anyone can change: opening settings reads them again.
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
  // Names switched on for a bot that nothing on disk answers to: shown so they can be switched off.
  const missing = view.bots.flatMap((b) => {
    const bot = byId.get(b.bot);
    if (!bot) return [];
    return b.enabled.filter((name) => !b.local.some((s) => s.name === name) && !view.shared.some((s) => s.name === name)).map((name) => ({ bot, name }));
  });
  const empty = view.shared.length === 0 && own.length === 0 && missing.length === 0;

  return (
    <Section
      title="Skills"
      action={
        <Button variant="link" size="link" disabled={refreshing} onClick={() => void refresh()}>
          <RefreshCw size={12.5} strokeWidth={2.2} className={cn(refreshing && "animate-spin motion-reduce:animate-none")} />
          Rescan
        </Button>
      }
    >
      <p className="m-0 px-4.5 py-3.5 text-meta leading-normal text-muted-foreground">
        A skill is a folder with a <span className={PATH}>SKILL.md</span>. Shared skills are in <span className={cn(PATH, "break-all")}>{view.library}</span>:
        every bot you switch one on for uses the same files, so a change to it (yours or a bot's) reaches all of them. A bot's own skills are in{" "}
        <span className={PATH}>.agents/skills</span> in its folder, and take the place of a shared one with the same name. A bot uses only the skills you switch
        on for it; type <span className={PATH}>/</span> in its message box to ask for one.
        {refreshError && <span className="mt-1 block text-destructive-foreground">{refreshError}</span>}
      </p>
      {empty && <p className="m-0 px-4.5 py-3.5 text-meta text-muted-foreground">No skills found yet. Add a folder and press Rescan.</p>}
      {view.shared.map((skill) => (
        <SkillRow key={`shared:${skill.name}`} skill={skill} badge={<Tag title="In the shared library: every bot that has it uses these files">Shared</Tag>}>
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
                    name={skill.name}
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
                name={skill.name}
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
          {(onError) => <BotToggle bot={bot} name={name} on title={`Switch ${name} off for ${bot.name}`} onError={onError} />}
        </SkillRow>
      ))}
    </Section>
  );
}
