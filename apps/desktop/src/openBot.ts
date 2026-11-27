import type { BotId } from "@top/client";

const OPEN_BOT = "top:open-bot";

/** Opens a bot's conversation, from anywhere in the window (a bot named in another's conversation, say). */
export function openBot(id: BotId) {
  dispatchEvent(new CustomEvent<BotId>(OPEN_BOT, { detail: id }));
}

export function onOpenBot(open: (id: BotId) => void): () => void {
  const listener = (event: Event) => open((event as CustomEvent<BotId>).detail);
  addEventListener(OPEN_BOT, listener);
  return () => removeEventListener(OPEN_BOT, listener);
}
