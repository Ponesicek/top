/**
 * The app's one TopClient, plus the local cache that makes cold start instant and reconnects cheap.
 *
 * The UI reads it through atoms (Effect's `effect/reactivity`) on one registry, `registry`, which
 * main.tsx provides to React: `clientAtom` follows the client's snapshot, `conversationAtom(sync)` a
 * bot's transcript, and the hooks below select from them so a component re-renders only when what
 * it shows changes.
 */

import { useAtomValue } from "@effect/atom-react";
import {
  type BotId,
  BotSummary,
  ConversationCache,
  type ConversationSnapshot,
  type ConversationSync,
  TopClient,
  type TopSnapshot,
  type Viewer,
} from "@top/client";
import * as Option from "effect/Option";
import * as Atom from "effect/reactivity/Atom";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import * as Schema from "effect/Schema";

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
/** A cached value, if it's there and still of the shape `schema` says (an older version's isn't). */
function cached<A>(key: string, schema: Schema.Decoder<A>): A | undefined {
  const raw = safeGet(key);
  return raw ? Option.getOrUndefined(Schema.decodeOption(Schema.fromJsonString(schema))(raw)) : undefined;
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
// For `pnpm bench` and `pnpm screenshot` (electron/bench-driver.js).
declare global {
  interface Window {
    __top?: TopClient;
  }
}
window.__top = top;

// ── hydrate from cache before the network answers ──────────────────────────────

const cachedBots = cachedServer ? cached(cacheKey("bots"), Schema.Array(BotSummary)) : undefined;
if (cachedBots) {
  top.hydrateBots(cachedBots);
  for (const bot of cachedBots) {
    const conversation = cached(cacheKey(`bot:${bot.id}`), ConversationCache);
    if (conversation) top.conversation(bot.id).hydrate(conversation);
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

// ── atoms ────────────────────────────────────────────────────────────────────

/** The app's atoms live here; main.tsx gives it to React, and code outside components sets atoms through it. */
export const registry = AtomRegistry.make();

/** An atom that follows an external store: its value now, then every change. */
const following = <A>(subscribe: (listener: () => void) => () => void, read: () => A) =>
  Atom.readable((get) => {
    get.addFinalizer(subscribe(() => get.setSelf(read())));
    return read();
  });

/** The client's snapshot: connection, roster, MCP servers, files, … */
export const clientAtom: Atom.Atom<TopSnapshot> = following(top.subscribe, top.getSnapshot).pipe(Atom.keepAlive);

/**
 * One bot's transcript, as its conversation has it. Keyed by the conversation itself, not the bot's id:
 * a deleted bot's id can come back for a new bot, which gets a new conversation.
 */
const conversationAtoms = new WeakMap<ConversationSync, Atom.Atom<ConversationSnapshot>>();
export function conversationAtom(sync: ConversationSync): Atom.Atom<ConversationSnapshot> {
  let atom = conversationAtoms.get(sync);
  if (!atom) {
    atom = following(sync.subscribe, sync.getSnapshot);
    conversationAtoms.set(sync, atom);
  }
  return atom;
}

/** A value from the client's snapshot; re-renders only when it changes. */
export function useClient<A>(select: (snapshot: TopSnapshot) => A): A {
  return useAtomValue(clientAtom, select);
}

/** A bot's transcript as it is now; re-renders on every change to it. */
export function useConversation(sync: ConversationSync): ConversationSnapshot {
  return useAtomValue(conversationAtom(sync));
}

// ── the daemon on the tailnet ──────────────────────────────────────────────────

export type TailnetInfo = { readonly tailnetUrl: string | undefined; readonly viewer: Viewer | undefined };

const tailnetAtom = Atom.make((get): TailnetInfo => {
  const { tailnetUrl, viewer } = get(clientAtom);
  const previous = get.self<TailnetInfo>();
  if (Option.isSome(previous) && previous.value.tailnetUrl === tailnetUrl && previous.value.viewer === viewer) return previous.value;
  return { tailnetUrl, viewer };
});

/** Where the daemon is on the tailnet, and who it says this app is (when it came in that way). */
export function useTailnet(): TailnetInfo {
  return useAtomValue(tailnetAtom);
}

export type RosterBot = { readonly id: BotId; readonly name: string };

const rosterAtom = Atom.make((get): { readonly key: string; readonly bots: readonly RosterBot[] } => {
  const bots = get(clientAtom).bots;
  const key = JSON.stringify(bots.map((b) => [b.id, b.name]));
  const previous = get.self<{ key: string; bots: readonly RosterBot[] }>();
  if (Option.isSome(previous) && previous.value.key === key) return previous.value;
  return { key, bots: bots.map(({ id, name }) => ({ id, name })) };
});

/** Every bot's id and name; re-renders only when a bot is added, removed or renamed, not on status changes. */
export function useRoster(): readonly RosterBot[] {
  return useAtomValue(rosterAtom, (roster) => roster.bots);
}

/** One bot's summary; re-renders only when that bot changes. */
export function useBot(id: BotId | undefined): BotSummary | undefined {
  return useClient((snapshot) => (id === undefined ? undefined : snapshot.bots.find((b) => b.id === id)));
}

// ── unread: the newest entry seen per bot, kept locally ─────────────────────────

const seenKey = cacheKey("seen");
const seenAtom = Atom.make<Readonly<Record<string, number>>>((cachedServer && cached(seenKey, Schema.Record(Schema.String, Schema.Number))) || {}).pipe(
  Atom.keepAlive,
);

// A different daemon (another --home, or a reset): the client has dropped what it held from the old
// one, so drop the cache and read marks too. They'd show its transcripts and hide new messages.
let currentServer = cachedServer;
top.subscribe(() => {
  const { serverId } = top.getSnapshot();
  if (!serverId || serverId === currentServer) return;
  if (currentServer !== undefined) {
    dropCache(cachePrefix);
    registry.set(seenAtom, {});
    registry.set(pinsAtom, []);
  }
  currentServer = serverId;
  safeSet(cacheKey("server"), serverId);
});

export function markSeen(id: BotId, seq: number) {
  const seen = registry.get(seenAtom);
  if ((seen[id] ?? 0) >= seq) return;
  const next = { ...seen, [id]: seq };
  registry.set(seenAtom, next);
  safeSet(seenKey, JSON.stringify(next));
}

export function useSeen(): Record<string, number> {
  return useAtomValue(seenAtom);
}

// ── pins: the bots kept at the top of the sidebar, in the order they were pinned, kept locally ──

const pinsKey = cacheKey("pins");
const pinsAtom = Atom.make<readonly BotId[]>((cachedServer && cached(pinsKey, Schema.Array(Schema.Int))) || []).pipe(Atom.keepAlive);

function setPins(next: readonly BotId[]) {
  registry.set(pinsAtom, next);
  safeSet(pinsKey, JSON.stringify(next));
}

/** Keep a bot at the top of the sidebar, below the bots pinned before it. */
export function pin(id: BotId) {
  const pins = registry.get(pinsAtom);
  if (!pins.includes(id)) setPins([...pins, id]);
}

export function unpin(id: BotId) {
  const pins = registry.get(pinsAtom);
  if (pins.includes(id)) setPins(pins.filter((p) => p !== id));
}

// A deleted bot's pin goes with it: its id can come back for a new bot.
top.subscribe(() => {
  const { bots, ready } = top.getSnapshot();
  const pins = registry.get(pinsAtom);
  if (!ready || pins.length === 0) return;
  const live = new Set(bots.map((b) => b.id));
  if (pins.some((id) => !live.has(id))) setPins(pins.filter((id) => live.has(id)));
});

export function usePins(): readonly BotId[] {
  return useAtomValue(pinsAtom);
}

/** The sidebar's two groups: pinned bots in pin order, then the rest in the daemon's order. */
export function sidebarGroups(bots: readonly BotSummary[], pins: readonly BotId[]): { pinned: BotSummary[]; rest: BotSummary[] } {
  const byId = new Map(bots.map((b) => [b.id, b]));
  const pinned = pins.flatMap((id) => byId.get(id) ?? []);
  const set = new Set(pinned.map((b) => b.id));
  return { pinned, rest: bots.filter((b) => !set.has(b.id)) };
}

/** Every bot in the order the sidebar shows them, which Ctrl+1…9 and Alt+↑/↓ follow. */
export function sidebarOrder(): BotSummary[] {
  const { pinned, rest } = sidebarGroups(top.getSnapshot().bots, registry.get(pinsAtom));
  return [...pinned, ...rest];
}
