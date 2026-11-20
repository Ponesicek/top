/** The list with the item at `from` moved to `to`, everything else in its order. */
export function move<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  if (from < 0 || from >= next.length) return next;
  const [item] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(to, next.length)), 0, item!);
  return next;
}

/**
 * The daemon's whole order after the unpinned bots are put in `rest`'s order: pinned bots, which this device lists
 * above the rest, keep their place in the daemon's order, so other devices see only the change made here.
 */
export function withRestOrder<T>(all: readonly T[], pinned: readonly T[], rest: readonly T[]): T[] {
  const isPinned = new Set(pinned);
  const queue = rest.filter((id) => all.includes(id) && !isPinned.has(id));
  const placed = new Set(queue);
  const out: T[] = [];
  for (const id of all) {
    if (isPinned.has(id) || !placed.has(id)) out.push(id);
    else out.push(queue.shift()!);
  }
  return out;
}

/** Which of `centers` a point is closest to: where an item dragged to that point goes. */
export function nearest(point: { x: number; y: number }, centers: readonly { x: number; y: number }[]): number {
  let best = -1;
  let distance = Number.POSITIVE_INFINITY;
  centers.forEach((c, i) => {
    const d = (c.x - point.x) ** 2 + (c.y - point.y) ** 2;
    if (d < distance) {
      distance = d;
      best = i;
    }
  });
  return best;
}
