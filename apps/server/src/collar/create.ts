import { MAX_BOT_AVATAR, MAX_BOT_DESCRIPTION } from "@top/protocol";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import Type from "typebox";
import { defineTool, type ToolResult, text } from "../tools.ts";
import type { CollarGroup, RosterBot } from "./index.ts";

/**
 * Bots making bots (collar__create_bot). The daemon makes the bot at once, the same way the app's New bot does, and
 * keeps it from running away:
 *
 * - A bot another bot made can't make bots itself, so it's never more than one level deep.
 * - A bot can make at most MAX_MADE_SINCE_USER bots since the user last wrote to it; the user writing again allows more.
 *   Wakes, jobs, tasks and other bots' messages don't, so nothing but the user can keep it making bots.
 */
export const MAX_MADE_SINCE_USER = 3;

const PURPOSE_PREVIEW_CHARS = 200;

const refused = (why: string): ToolResult => ({ ...text(why), isError: true });

function receipt(bot: RosterBot, avatar: number): ToolResult {
  const purpose = bot.about.length > PURPOSE_PREVIEW_CHARS ? `${bot.about.slice(0, PURPOSE_PREVIEW_CHARS - 1)}…` : bot.about;
  return {
    ...text(
      `Created ${bot.name} (bot ${bot.id}). It's in the user's sidebar, idle until someone writes to it. To give it work, send it a message with collar__message_bot (to: "${bot.name}"); write everything it needs: it hasn't seen your conversation.`,
    ),
    details: { createdBot: { id: bot.id, name: bot.name, purpose, ...(avatar ? { avatar } : {}) } },
  };
}

export const createGroup: CollarGroup = (daemon) => {
  // One at a time, so two calls in one turn can't both slip under the limit, or race for one name.
  const making = Semaphore.makeUnsafe(1);
  return [
    defineTool({
      name: "create_bot",
      label: "Create a bot",
      description: [
        "Make a new bot for the user, a teammate on this daemon, when a task needs one with its own purpose (a reviewer, a researcher, someone to watch something). It shows in the user's sidebar at once, with its own folder and conversation.",
        "Give it a `name` and its `purpose` (one or two sentences, the line under its name in the app); `soul` adds more to its SOUL.md under that (how it works, its voice), and `agents` writes its AGENTS.md (standing instructions). Each file is at most 8 KB.",
        "It starts idle and knows nothing of your conversation, and gets the default tools only: none of your MCP servers or secrets. To give it work, message it with collar__message_bot once this returns.",
        `You can make at most ${MAX_MADE_SINCE_USER} bots since the user last wrote to you, and a bot made by a bot can't make bots. Don't make one for what you can do yourself or what an existing bot (<bots>) is for.`,
      ].join(" "),
      parameters: Type.Object(
        {
          name: Type.String({ description: "Its name, shown in the sidebar. Not one another bot has." }),
          purpose: Type.String({ description: "What it's for, in a sentence or two." }),
          soul: Type.Optional(Type.String({ description: "More for its SOUL.md, under the purpose: how it works, its voice. Markdown." })),
          agents: Type.Optional(Type.String({ description: "Its AGENTS.md: standing instructions, procedures. Markdown." })),
          model: Type.Optional(
            Type.String({
              description: "Leave out for the daemon's model. `claude/<model>` (default, opus, sonnet, haiku) runs it on Claude Code, where the daemon does.",
            }),
          ),
          avatar: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_BOT_AVATAR, description: "Its icon's number; leave out for one from its name." })),
        },
        { additionalProperties: false },
      ),
      // Making is keyed by the call: run again after a restart, it finds the bot it made and makes none.
      replay: "safe",
      background: false,
      executionMode: "sequential",
      run: (args, ctx) =>
        making.withPermits(1)(
          Effect.gen(function* () {
            const store = daemon.store;
            const known = yield* store.botMadeBy(ctx.key);
            if (known) {
              const made = (yield* daemon.roster).find((b) => b.id === known.id);
              const row = yield* store.bot(known.id);
              if (!made || known.deleted) return text("You made that bot with this call earlier; it has been deleted since.");
              return receipt(made, row?.avatar ?? 0);
            }
            const me = (yield* daemon.roster).find((b) => b.id === ctx.bot);
            const row = yield* store.bot(ctx.bot);
            if (!me || !row) return refused("Not created: you're being deleted.");
            if (row.createdBy !== null)
              return refused(
                "Not created: you were made by another bot, and bots made by bots can't make bots. Do it yourself, or tell the bot that made you what you need.",
              );
            if ((yield* store.madeSinceUser(ctx.bot)) >= MAX_MADE_SINCE_USER)
              return refused(
                `Not created: you've made ${MAX_MADE_SINCE_USER} bots since the user last wrote to you, the most Top allows. Tell the user why you need another; they can ask you to.`,
              );
            // One plain paragraph: it's SOUL.md's first, which the sidebar and every bot's <bots> show.
            const purpose = args.purpose.trim().replace(/\s+/g, " ");
            if (!purpose) return refused("Not created: say what it's for with `purpose`.");
            if (/^(#|<!--|---|```)/.test(purpose)) return refused("Not created: write `purpose` as a plain sentence; put headings and the rest in `soul`.");
            if (purpose.length > MAX_BOT_DESCRIPTION)
              return refused(`Not created: keep \`purpose\` under ${MAX_BOT_DESCRIPTION + 1} characters; put more in \`soul\`.`);
            const made = yield* Effect.result(
              daemon.createBot(args.name, purpose, args.avatar ?? 0, args.model, {
                soul: args.soul,
                agents: args.agents,
                origin: { by: ctx.bot, byName: me.name, key: ctx.key },
              }),
            );
            if (made._tag === "Failure") return refused(`Not created: ${made.failure.message}`);
            const bot = (yield* daemon.roster).find((b) => b.id === made.success);
            return receipt(bot ?? { id: made.success, name: args.name.trim(), about: purpose }, args.avatar ?? 0);
          }),
        ),
    }),
  ];
};
