import * as Effect from "effect/Effect";
import Type from "typebox";
import { type BotMessageRow, MAX_BOT_MESSAGE_CHARS, MAX_HOPS } from "../botMessages.ts";
import { defineTool, type ToolResult, text } from "../tools.ts";
import type { CollarGroup, RosterBot } from "./index.ts";

const PREVIEW_CHARS = 500;

const refused = (why: string): ToolResult => ({ ...text(why), isError: true });

const sameName = (a: string, b: string) => a.trim().replace(/^@/, "").toLowerCase() === b.trim().toLowerCase();

const rosterLine = (others: readonly RosterBot[]) =>
  others.length ? `You can message: ${others.map((b) => b.name).join(", ")}.` : "There are no other bots to message.";

/** The roster, as a section of the instructions: it changes only when a bot is made, renamed or deleted. */
export function rosterSection(roster: readonly RosterBot[], self: number): string | null {
  const others = roster.filter((b) => b.id !== self);
  if (!others.length) return null;
  const lines = others.map((b) => `- ${b.name.replace(/\s+/g, " ")}${b.about ? `: ${b.about.replace(/\s+/g, " ")}` : ""}`);
  return [
    "<bots>",
    "The user's other bots on this daemon. You can message one with collar__message_bot, by name, and reply to theirs; nobody else can.",
    ...lines,
    "</bots>",
  ].join("\n");
}

function receipt(message: BotMessageRow): ToolResult {
  const said =
    message.replyTo === null
      ? `Sent message ${message.id} to ${message.recipientName}. It reaches ${message.recipientName} once it's done with what it's doing now, and its reply comes to you as a message. Don't wait for it: carry on, or end your turn.`
      : `Sent your reply to message ${message.replyTo} to ${message.recipientName} (as message ${message.id}).`;
  return {
    ...text(said),
    details: {
      botMessage: {
        id: message.id,
        to: message.recipient,
        name: message.recipientName,
        text: message.text.length > PREVIEW_CHARS ? `${message.text.slice(0, PREVIEW_CHARS - 1)}…` : message.text,
        ...(message.replyTo === null ? {} : { replyTo: message.replyTo }),
      },
    },
  };
}

export const messagesGroup: CollarGroup = (daemon) => [
  defineTool({
    name: "message_bot",
    label: "Message a bot",
    description: [
      "Send a message to another of the user's bots on this daemon, or reply to one a bot sent you. The bots you can message are in your instructions (<bots>).",
      "A new message: `to` (the bot's name) and `text`. It returns at once with the message's number. The other bot reads it after the turn it's in, and its reply comes to you as a message, so don't wait: carry on, or end your turn.",
      "A reply: `reply_to` (the number in the message's first line) and `text`; it goes back to whoever sent it. A message gets at most one reply, and a reply takes none. Your turn's final text never reaches another bot: only this tool does. You can reply later, after work that takes several turns.",
      `Write what the other bot needs: it hasn't seen your conversation. Bots can't trade more than ${MAX_HOPS} messages in a row without the user writing again.`,
    ].join(" "),
    parameters: Type.Object(
      {
        to: Type.Optional(Type.String({ description: "The bot to message, by name. Not needed with `reply_to`." })),
        text: Type.String({ description: "The message." }),
        reply_to: Type.Optional(Type.Integer({ description: "Reply to this message, which a bot sent you." })),
      },
      { additionalProperties: false },
    ),
    // Sending is keyed by the call: run again after a restart, it finds what it sent and sends nothing more.
    replay: "safe",
    background: false,
    run: (args, ctx) =>
      Effect.gen(function* () {
        const store = daemon.store;
        const known = yield* store.botMessageByKey(ctx.key);
        if (known) return receipt(known);

        const roster = daemon.roster();
        const me = roster.find((b) => b.id === ctx.bot);
        if (!me) return refused("Not sent: you're being deleted.");
        const others = roster.filter((b) => b.id !== ctx.bot);
        const body = args.text.trim();
        if (!body) return refused("Not sent: the message is empty.");
        if (body.length > MAX_BOT_MESSAGE_CHARS)
          return refused(`Not sent: keep a message under ${MAX_BOT_MESSAGE_CHARS + 1} characters. Put more in a file and say where it is.`);

        let recipient: RosterBot;
        let replyTo: number | null = null;
        let chain: { chain: number; hop: number } | undefined;
        if (args.reply_to !== undefined) {
          const original = yield* store.botMessage(args.reply_to);
          if (!original || original.recipient !== ctx.bot)
            return refused(`Not sent: no bot sent you a message ${args.reply_to}. A message's number is in its first line.`);
          if (original.state === "reply")
            return refused(
              `Not sent: message ${original.id} is ${original.senderName}'s reply to you, which takes none. To say more, send a new message with \`to\`.`,
            );
          if (original.state === "replied") return refused(`Not sent: you already replied to message ${original.id}.`);
          if (original.state !== "open")
            return refused(`Not sent: message ${original.id} ended when the user stopped you, and ${original.senderName} was told you won't reply.`);
          const sender = roster.find((b) => b.id === original.sender);
          if (!sender) return refused(`Not sent: ${original.senderName} has been deleted, so there's no one to reply to.`);
          if (args.to !== undefined && !sameName(args.to, sender.name))
            return refused(
              `Not sent: message ${original.id} is from ${sender.name}, and a reply goes back to its sender. To message ${args.to}, leave out \`reply_to\`.`,
            );
          recipient = sender;
          replyTo = original.id;
          chain = { chain: original.chain, hop: original.hop };
        } else {
          if (args.to === undefined || !args.to.trim()) return refused(`Not sent: say who it's for with \`to\`. ${rosterLine(others)}`);
          const to = args.to;
          if (sameName(to, me.name)) return refused("Not sent: that's you. Message another bot.");
          const named = others.filter((b) => sameName(to, b.name));
          if (named.length === 0) return refused(`Not sent: there's no bot named ${to.trim()}. ${rosterLine(others)}`);
          if (named.length > 1)
            return refused(`Not sent: ${named.length} bots are named ${named[0]!.name}, so Top can't tell which you mean. Ask the user to rename one.`);
          recipient = named[0]!;
          chain = yield* store.chainOf(ctx.bot);
          const hop = (chain?.hop ?? 0) + 1;
          if (hop > MAX_HOPS)
            return refused(
              `Not sent: this exchange between bots is already ${MAX_HOPS} messages long since the user last wrote, the most Top allows, so it can't loop. Stop here and tell the user where things stand; they can ask you to carry on.`,
            );
          if (chain && (yield* store.repeatedInChain(chain.chain, ctx.bot, recipient.id, body)))
            return refused(`Not sent: you already sent ${recipient.name} exactly this in this exchange.`);
        }

        const result = yield* store.sendBotMessage({
          key: ctx.key,
          sender: ctx.bot,
          senderName: me.name,
          recipient: recipient.id,
          recipientName: recipient.name,
          replyTo,
          chain,
          text: body,
        });
        if ("known" in result) return receipt(result.known);
        if ("taken" in result)
          return refused(
            result.taken.state === "replied"
              ? `Not sent: you already replied to message ${result.taken.id}.`
              : `Not sent: message ${result.taken.id} ended when the user stopped you.`,
          );
        yield* daemon.deliver(result.inbox);
        return receipt(result.sent);
      }),
  }),
];
