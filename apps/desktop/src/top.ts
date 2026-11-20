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

export function connectTo(url: string) {
  safeSet("top.server", url);
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
  } catch {}
}
function cached<A>(key: string, schema: Schema.Decoder<A>): A | undefined {
  const raw = safeGet(key);
  return raw ? Option.getOrUndefined(Schema.decodeOption(Schema.fromJsonString(schema))(raw)) : undefined;
}

const cachePrefix = `top.cache.v4:${serverUrl}:`;
const cacheKey = (suffix: string) => cachePrefix + suffix;
function dropCache(prefix: string) {
  try {
    for (const key of Object.keys(localStorage)) if (key.startsWith(prefix)) localStorage.removeItem(key);
  } catch {}
}
dropCache("top.cache.v2:");
dropCache("top.cache.v3:");

const cachedServer = safeGet(cacheKey("server")) ?? undefined;
export const top = new TopClient({ url: serverUrl, ...(cachedServer ? { serverId: cachedServer } : {}) });
declare global {
  interface Window {
    __top?: TopClient;
  }
}
window.__top = top;

const cachedBots = cachedServer ? cached(cacheKey("bots"), Schema.Array(BotSummary)) : undefined;
if (cachedBots) {
  top.hydrateBots(cachedBots);
  for (const bot of cachedBots) {
    const conversation = cached(cacheKey(`bot:${bot.id}`), ConversationCache);
    if (conversation) top.conversation(bot.id).hydrate(conversation);
  }
}

const retained = new Set<BotId>();
function retainAll() {
  const { bots, ready } = top.getSnapshot();
  for (const bot of bots) {
    if (retained.has(bot.id)) continue;
    retained.add(bot.id);
    top.conversation(bot.id).retain();
  }
  if (!ready) return;
  const live = new Set(bots.map((b) => b.id));
  for (const id of retained) {
    if (live.has(id)) continue;
    retained.delete(id);
    try {
      localStorage.removeItem(cacheKey(`bot:${id}`));
    } catch {}
  }
}
retainAll();
top.subscribe(retainAll);

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

addEventListener("online", () => top.kick());
document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && top.kick());

export function conversation(id: BotId): ConversationSync {
  return top.conversation(id);
}

export const registry = AtomRegistry.make();

const following = <A>(subscribe: (listener: () => void) => () => void, read: () => A) =>
  Atom.readable((get) => {
    get.addFinalizer(subscribe(() => get.setSelf(read())));
    return read();
  });

export const clientAtom: Atom.Atom<TopSnapshot> = following(top.subscribe, top.getSnapshot).pipe(Atom.keepAlive);

const conversationAtoms = new WeakMap<ConversationSync, Atom.Atom<ConversationSnapshot>>();
export function conversationAtom(sync: ConversationSync): Atom.Atom<ConversationSnapshot> {
  let atom = conversationAtoms.get(sync);
  if (!atom) {
    atom = following(sync.subscribe, sync.getSnapshot);
    conversationAtoms.set(sync, atom);
  }
  return atom;
}

export function useClient<A>(select: (snapshot: TopSnapshot) => A): A {
  return useAtomValue(clientAtom, select);
}

export function useConversation(sync: ConversationSync): ConversationSnapshot {
  return useAtomValue(conversationAtom(sync));
}

export type TailnetInfo = { readonly tailnetUrl: string | undefined; readonly viewer: Viewer | undefined };

const tailnetAtom = Atom.make((get): TailnetInfo => {
  const { tailnetUrl, viewer } = get(clientAtom);
  const previous = get.self<TailnetInfo>();
  if (Option.isSome(previous) && previous.value.tailnetUrl === tailnetUrl && previous.value.viewer === viewer) return previous.value;
  return { tailnetUrl, viewer };
});

export function useTailnet(): TailnetInfo {
  return useAtomValue(tailnetAtom);
}

export type RosterBot = { readonly id: BotId; readonly name: string; readonly avatar: number | undefined };

const rosterAtom = Atom.make((get): { readonly key: string; readonly bots: readonly RosterBot[] } => {
  const bots = get(clientAtom).bots;
  const key = JSON.stringify(bots.map((b) => [b.id, b.name, b.avatar ?? 0]));
  const previous = get.self<{ key: string; bots: readonly RosterBot[] }>();
  if (Option.isSome(previous) && previous.value.key === key) return previous.value;
  return { key, bots: bots.map(({ id, name, avatar }) => ({ id, name, avatar })) };
});

export function useRoster(): readonly RosterBot[] {
  return useAtomValue(rosterAtom, (roster) => roster.bots);
}

export function useBot(id: BotId | undefined): BotSummary | undefined {
  return useClient((snapshot) => (id === undefined ? undefined : snapshot.bots.find((b) => b.id === id)));
}

const seenKey = cacheKey("seen");
const seenAtom = Atom.make<Readonly<Record<string, number>>>((cachedServer && cached(seenKey, Schema.Record(Schema.String, Schema.Number))) || {}).pipe(
  Atom.keepAlive,
);

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

const pinsKey = cacheKey("pins");
const pinsAtom = Atom.make<readonly BotId[]>((cachedServer && cached(pinsKey, Schema.Array(Schema.Int))) || []).pipe(Atom.keepAlive);

function setPins(next: readonly BotId[]) {
  registry.set(pinsAtom, next);
  safeSet(pinsKey, JSON.stringify(next));
}

export function pin(id: BotId) {
  const pins = registry.get(pinsAtom);
  if (!pins.includes(id)) setPins([...pins, id]);
}

export function unpin(id: BotId) {
  const pins = registry.get(pinsAtom);
  if (pins.includes(id)) setPins(pins.filter((p) => p !== id));
}

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

export function sidebarGroups(bots: readonly BotSummary[], pins: readonly BotId[]): { pinned: BotSummary[]; rest: BotSummary[] } {
  const byId = new Map(bots.map((b) => [b.id, b]));
  const pinned = pins.flatMap((id) => byId.get(id) ?? []);
  const set = new Set(pinned.map((b) => b.id));
  return { pinned, rest: bots.filter((b) => !set.has(b.id)) };
}

export function sidebarOrder(): BotSummary[] {
  const { pinned, rest } = sidebarGroups(top.getSnapshot().bots, registry.get(pinsAtom));
  return [...pinned, ...rest];
}
