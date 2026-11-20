/** How close to the end still counts as at the end. */
export const BOTTOM_SLACK = 48;
/** How long after a wheel turn, a key or a finger moving a scroll still counts as the person's. */
export const INPUT_MS = 350;

export type Scroll = { readonly top: number; readonly height: number; readonly client: number };

/**
 * Whether the conversation stays pinned to its end after a scroll. Only the person scrolling up (wheel, keys, touch,
 * the scrollbar) un-pins it; a scroll the layout caused, like a row being swapped for a shorter one, never does.
 */
export function stillPinned(pinned: boolean, scroll: Scroll, lastTop: number, byPerson: boolean): boolean {
  if (scroll.height - scroll.top - scroll.client < BOTTOM_SLACK) return true;
  if (!pinned) return false;
  return !(byPerson && scroll.top < lastTop);
}

const listeners = new Map<string, Set<() => void>>();

/** Asks the conversation with this bot to go to its end and stay there: after you send it a message. */
export function pinToEnd(bot: number | string) {
  for (const listener of listeners.get(String(bot)) ?? []) listener();
}

export function onPinToEnd(bot: number | string, listener: () => void): () => void {
  const key = String(bot);
  const set = listeners.get(key) ?? new Set();
  listeners.set(key, set);
  set.add(listener);
  return () => set.delete(listener);
}
