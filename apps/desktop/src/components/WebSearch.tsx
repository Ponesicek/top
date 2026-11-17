/**
 * Settings → Web search: which bots may search the web with OpenAI's own web search. It's OpenAI's tool,
 * run on OpenAI's side while the bot answers, so it's here only when the bots' model is OpenAI's. Whether
 * the user's plan, workspace and model may use it is OpenAI's call; when it says no, the answer says so.
 */
import { useState } from "react";
import { type RosterBot, top, useRoster, useWebSearch } from "../top.ts";
import { messageOf } from "./BotDialogs.tsx";
import { BotChip, Section } from "./SettingsSection.tsx";

/** A bot's chip: on means it may search. Flips at once; the daemon's answer settles it. */
function BotToggle({ bot, on, onError }: { bot: RosterBot; on: boolean; onError: (error: string | undefined) => void }) {
  const [pending, setPending] = useState<boolean>();
  const shown = pending ?? on;
  const toggle = async () => {
    const next = !shown;
    setPending(next);
    onError(undefined);
    try {
      await top.setWebSearch(bot.id, next);
    } catch (err) {
      onError(messageOf(err));
    }
    setPending(undefined);
  };
  return (
    <BotChip on={shown} onClick={() => void toggle()} title={shown ? `${bot.name} may search the web. Click to stop it.` : `Let ${bot.name} search the web`}>
      {bot.name}
    </BotChip>
  );
}

export function WebSearch() {
  const allowed = useWebSearch();
  const roster = useRoster();
  const [error, setError] = useState<string>();
  const bots = roster.filter((bot) => allowed.has(bot.id));
  if (!bots.length) return null;
  return (
    <Section title="Web search">
      <div className="flex flex-col gap-2.5 px-4.5 py-3.5">
        <p className="m-0 text-meta leading-normal text-muted-foreground">
          A bot you switch on may search the web while it answers, with OpenAI's own web search, and links the pages it used. Whether your plan, workspace and
          model allow it is up to OpenAI: if they don't, the bot's answer says so. It picks this up from its next message.
        </p>
        {error && <p className="m-0 text-meta leading-normal text-destructive-foreground">{error}</p>}
        <div className="flex flex-wrap items-center gap-1.5">
          {bots.map((bot) => (
            <BotToggle key={bot.id} bot={bot} on={allowed.get(bot.id) === true} onError={setError} />
          ))}
        </div>
      </div>
    </Section>
  );
}
