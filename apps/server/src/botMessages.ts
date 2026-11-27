import * as Schema from "effect/Schema";

/**
 * Bot-to-bot messages (collar__message_bot). A message goes into the recipient's inbox as a follow-up, so it waits for
 * the turn the recipient is in; a reply goes back the same way. The daemon, not the model, keeps the exchange from
 * running away:
 *
 * - A chain starts when a bot messages another from a turn the user (not a bot) last spoke in. Every message in it
 *   counts one hop more than the message that led to it; a reply one more than the message it answers.
 * - A new message past MAX_HOPS is refused, so two bots can trade at most two rounds (message, reply, message, reply)
 *   before the user has to write again. Replies are never refused for depth: each message takes at most one, and a
 *   reply takes none, so they can't loop.
 * - The same text to the same bot twice in one chain is refused.
 */
export const MAX_HOPS = 4;
export const MAX_BOT_MESSAGE_CHARS = 16_000;

/** open: waits for a reply. replied / stopped / deleted: settled. reply: a reply, which takes none. */
export const BotMessageState = Schema.Literals(["open", "replied", "stopped", "deleted", "reply"]);
export type BotMessageState = typeof BotMessageState.Type;

export const BotMessageRow = Schema.Struct({
  id: Schema.Int,
  key: Schema.String,
  sender: Schema.Int,
  senderName: Schema.String,
  recipient: Schema.Int,
  recipientName: Schema.String,
  replyTo: Schema.NullOr(Schema.Int),
  chain: Schema.Int,
  hop: Schema.Int,
  text: Schema.String,
  state: BotMessageState,
  at: Schema.Number,
}).pipe(Schema.encodeKeys({ senderName: "sender_name", recipientName: "recipient_name", replyTo: "reply_to" }));
export type BotMessageRow = typeof BotMessageRow.Type;

/** The inbox row's request id: the message itself, or the daemon's word on what became of it. */
export const messageRequest = (id: number) => `bot:${id}`;
export const outcomeRequest = (id: number) => `bot-outcome:${id}`;
export const requestMessageId = (requestId: string): number | undefined => {
  const match = /^bot(?:-outcome)?:(\d+)$/.exec(requestId);
  return match ? Number(match[1]) : undefined;
};

/**
 * What the recipient reads: a header line saying who it's from and how to answer, then the text as sent. The header is
 * the first line only, so the apps can show the text without it (peerBody).
 */
export function messageText(row: Pick<BotMessageRow, "id" | "senderName" | "replyTo" | "text">): string {
  const header =
    row.replyTo === null
      ? `[Message ${row.id} from ${row.senderName}, another bot, not the user. To answer, use collar__message_bot with reply_to: ${row.id}, now or once you have the answer; your turn's final text doesn't reach ${row.senderName}.]`
      : `[Reply ${row.id} from ${row.senderName} to your message ${row.replyTo}. It needs no reply; to say more, send a new message.]`;
  return `${header}\n${row.text}`;
}

export function outcomeText(row: Pick<BotMessageRow, "id" | "recipientName">, outcome: "stopped" | "deleted"): string {
  const why = outcome === "stopped" ? "the user stopped it" : "it was deleted";
  return `[Message ${row.id} to ${row.recipientName}] ${row.recipientName} won't reply: ${why} before it did.`;
}

/** The text a bot sent, without the header the daemon gave it. */
export const peerBody = (text: string): string => {
  const at = text.indexOf("\n");
  return at === -1 ? "" : text.slice(at + 1);
};
