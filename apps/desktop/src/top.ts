/** The app's one TopClient, plus the local cache that makes cold start instant. */
import { TopClient, type BotSummary, type ConversationSync, type ConversationView } from "@top/client";

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

const cacheKey = (suffix: string) => `top.cache:${serverUrl}:${suffix}`;

export const top = new TopClient({ url: serverUrl });
(window as unknown as { __top: TopClient }).__top = top;

// ── hydrate from cache before the network answers ──────────────────────────────

const cachedBots = safeGet(cacheKey("bots"));
if (cachedBots) {
  const bots = JSON.parse(cachedBots) as BotSummary[];
  top.hydrateBots(bots);
  for (const bot of bots) {
    const cached = safeGet(cacheKey(`view:${bot.id}`));
    if (cached) top.conversation(bot.id).hydrate(JSON.parse(cached) as ConversationView);
  }
}

// ── keep every bot synced, so switching is instant ─────────────────────────────

const retained = new Set<string>();
function retainAll() {
  for (const bot of top.getSnapshot().bots) {
    if (retained.has(String(bot.id))) continue;
    retained.add(String(bot.id));
    top.conversation(bot.id).retain();
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
    const view = top.conversation(bot.id).exportView();
    if (view) safeSet(cacheKey(`view:${bot.id}`), JSON.stringify(view));
  }
}
const idle = (fn: () => void) =>
  "requestIdleCallback" in window ? requestIdleCallback(fn, { timeout: 2_000 }) : setTimeout(fn, 0);
setInterval(() => idle(persist), 3_000);
addEventListener("pagehide", persist);

// ── reconnect the moment the OS says we're back ────────────────────────────────

addEventListener("online", () => top.kick());
document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && top.kick());

export function conversation(id: BotSummary["id"]): ConversationSync {
  return top.conversation(id);
}
