/** The app's one TopClient, plus the local cache that makes cold start instant and reconnects cheap. */

import { type BotId, type BotSummary, type ConversationCache, type ConversationSync, TopClient, type Viewer } from "@top/client";
import { useSyncExternalStore } from "react";

const params = new URLSearchParams(location.search);
export const DEFAULT_SERVER = "ws://127.0.0.1:7357";
export const serverUrl = params.get("server") ?? safeGet("top.server") ?? DEFAULT_SERVER;

/**
 * What someone typed as a daemon's address, as a WebSocket URL: `box.tail1234.ts.net:7357` and
 * `https://…` mean `wss://…`; this computer (`localhost:7357`) means plain `ws://`.
 */
export function daemonUrl(input: string): string | undefined {
  let text = input.trim();
  if (!text) return undefined;
  text = text.replace(/^http(s?):\/\//i, "ws$1://");
  if (!/^wss?:\/\//i.test(text)) {
    const local = /^(localhost|127\.[\d.]+|\[::1\])(:|$)/i.test(text);
    text = `${local ? "ws" : "wss"}://${text}`;
  }
  try {
    const url = new URL(text);
    if (!url.hostname || (url.pathname !== "/" && url.pathname !== "")) return undefined;
    return `${url.protocol}//${url.host}`;
  } catch {
    return undefined;
  }
}

/** Use another daemon. The page starts over: what it holds (and caches) belongs to the old one. */
export function connectTo(url: string) {
  safeSet("top.server", url);
  // `?server=` would win over the saved address; drop it without navigating (the desktop app blocks that).
  const here = new URL(location.href);
  if (here.searchParams.has("server")) {
    here.searchParams.delete("server");
    history.replaceState(history.state, "", here);
  }
  location.reload();
}

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
const idle = (fn: () => void) => ("requestIdleCallback" in window ? requestIdleCallback(fn, { timeout: 2_000 }) : setTimeout(fn, 0));
setInterval(() => idle(persist), 5_000);
addEventListener("pagehide", persist);

// ── reconnect, or check the socket, the moment the OS says something changed ───

addEventListener("online", () => top.kick());
document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && top.kick());

export function conversation(id: BotId): ConversationSync {
  return top.conversation(id);
}

// ── the daemon on the tailnet ──────────────────────────────────────────────────

export type TailnetInfo = { readonly tailnetUrl: string | undefined; readonly viewer: Viewer | undefined };
let tailnetInfo: TailnetInfo = { tailnetUrl: undefined, viewer: undefined };
function tailnetSnapshot(): TailnetInfo {
  const { tailnetUrl, viewer } = top.getSnapshot();
  if (tailnetUrl !== tailnetInfo.tailnetUrl || viewer !== tailnetInfo.viewer) tailnetInfo = { tailnetUrl, viewer };
  return tailnetInfo;
}

/** Where the daemon is on the tailnet, and who it says this app is (when it came in that way). */
export function useTailnet(): TailnetInfo {
  return useSyncExternalStore(top.subscribe, tailnetSnapshot);
}

export type RosterBot = { readonly id: BotId; readonly name: string };

let roster: { readonly key: string; readonly bots: readonly RosterBot[] } = { key: "[]", bots: [] };
function rosterSnapshot(): readonly RosterBot[] {
  const bots = top.getSnapshot().bots;
  const key = JSON.stringify(bots.map((b) => [b.id, b.name]));
  if (key !== roster.key) roster = { key, bots: bots.map(({ id, name }) => ({ id, name })) };
  return roster.bots;
}

/** Every bot's id and name; re-renders only when a bot is added, removed or renamed, not on status changes. */
export function useRoster(): readonly RosterBot[] {
  return useSyncExternalStore(top.subscribe, rosterSnapshot);
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
