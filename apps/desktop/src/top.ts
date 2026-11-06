/** The app's one TopClient, plus the local cache that makes cold start instant and reconnects cheap. */
import { useSyncExternalStore } from "react";
import { TopClient, type BotId, type BotSummary, type ConversationCache, type ConversationSync } from "@top/client";

const params = new URLSearchParams(location.search);
export const serverUrl = params.get("server") ?? safeGet("top.server") ?? "ws://127.0.0.1:7357";

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function safeSet(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // quota or disabled storage: the cache is a convenience only
  }
}
function safeJson<T>(key: string): T | undefined {
  try {
    const raw = safeGet(key);
    return raw ? (JSON.parse(raw) as T) : undefined;
  } catch {
    return undefined;
  }
}

// v3 records which daemon the cache came from; v2 didn't, so it can't be trusted and is dropped.
const cachePrefix = `top.cache.v3:${serverUrl}:`;
const cacheKey = (suffix: string) => cachePrefix + suffix;
function dropCache(prefix: string) {
  try {
    for (const key of Object.keys(localStorage)) if (key.startsWith(prefix)) localStorage.removeItem(key);
  } catch {
    // disabled storage: nothing cached
  }
}
dropCache("top.cache.v2:");

const cachedServer = safeGet(cacheKey("server")) ?? undefined;
export const top = new TopClient({ url: serverUrl, ...(cachedServer ? { serverId: cachedServer } : {}) });
(window as unknown as { __top: TopClient }).__top = top;

// ── hydrate from cache before the network answers ──────────────────────────────

const cachedBots = cachedServer ? safeJson<BotSummary[]>(cacheKey("bots")) : undefined;
if (cachedBots) {
  top.hydrateBots(cachedBots);
  for (const bot of cachedBots) {
    const cached = safeJson<ConversationCache>(cacheKey(`bot:${bot.id}`));
    if (cached) top.conversation(bot.id).hydrate(cached);
  }
}

// ── keep every bot synced on the desktop, so switching is instant ──────────────
// (Without streaming a busy bot costs one message per step, so this is cheap even on a slow link.
// The phone app retains only the open bot.)

const retained = new Set<BotId>();
function retainAll() {
  const { bots, ready } = top.getSnapshot();
  for (const bot of bots) {
    if (retained.has(bot.id)) continue;
    retained.add(bot.id);
    top.conversation(bot.id).retain();
  }
  // A deleted bot: the client has dropped its conversation; drop its cached transcript too.
  if (!ready) return;
  const live = new Set(bots.map((b) => b.id));
  for (const id of retained) {
    if (live.has(id)) continue;
    retained.delete(id);
    try {
      localStorage.removeItem(cacheKey(`bot:${id}`));
    } catch {
      // disabled storage: nothing cached
    }
  }
}
retainAll();
top.subscribe(retainAll);

// ── write the cache now and then, never on the hot path ────────────────────────

function persist() {
  const { bots, ready } = top.getSnapshot();
  if (!ready) return;
  safeSet(cacheKey("bots"), JSON.stringify(bots));
  for (const bot of bots) {
    const cache = top.conversation(bot.id).exportCache();
    if (cache) safeSet(cacheKey(`bot:${bot.id}`), JSON.stringify(cache));
  }
}
const idle = (fn: () => void) =>
  "requestIdleCallback" in window ? requestIdleCallback(fn, { timeout: 2_000 }) : setTimeout(fn, 0);
setInterval(() => idle(persist), 5_000);
addEventListener("pagehide", persist);

// ── reconnect, or check the socket, the moment the OS says something changed ───

addEventListener("online", () => top.kick());
document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && top.kick());

export function conversation(id: BotId): ConversationSync {
  return top.conversation(id);
}

/** One bot's summary; re-renders only when that bot changes. */
export function useBot(id: BotId | undefined): BotSummary | undefined {
  return useSyncExternalStore(top.subscribe, () => (id === undefined ? undefined : top.getSnapshot().bots.find((b) => b.id === id)));
}

// ── unread: the newest entry seen per bot, kept locally ─────────────────────────

const seenKey = cacheKey("seen");
let seen: Record<string, number> = (cachedServer && safeJson<Record<string, number>>(seenKey)) || {};
const seenListeners = new Set<() => void>();

// A different daemon (another --data, or a reset): the client has dropped what it held from the old
// one, so drop the cache and read marks too. They'd show its transcripts and hide new messages.
let currentServer = cachedServer;
top.subscribe(() => {
  const { serverId } = top.getSnapshot();
  if (!serverId || serverId === currentServer) return;
  if (currentServer !== undefined) {
    dropCache(cachePrefix);
    seen = {};
    for (const listener of seenListeners) listener();
  }
  currentServer = serverId;
  safeSet(cacheKey("server"), serverId);
});

export function markSeen(id: BotId, seq: number) {
  if ((seen[id] ?? 0) >= seq) return;
  seen = { ...seen, [id]: seq };
  safeSet(seenKey, JSON.stringify(seen));
  for (const listener of seenListeners) listener();
}

export function useSeen(): Record<string, number> {
  return useSyncExternalStore(
    (listener) => {
      seenListeners.add(listener);
      return () => seenListeners.delete(listener);
    },
    () => seen,
  );
}
