/**
 * A client's copy of one bot's transcript.
 *
 * Entries are finished and never change, so the copy is a sorted list plus the ranges it doesn't
 * have: older history ("earlier") and holes left by a long disconnect ("gaps"). Both load when
 * scrolled into view. On every (re)connect the client asks only for entries after the newest one it
 * holds, so reopening the app after a while costs the new messages, not the transcript.
 *
 * Messages the user sends show up instantly as pending, survive a dropped connection, and are resent
 * with the same `requestId` (applied once by the daemon) until the daemon has them.
 */
import type { BotId, Entry, Gap, HistoryResult, QueuedMessage, Seq, SubmitResult, WhenBusy } from "@top/protocol";
import type { Connection } from "./connection.ts";

export type PendingMessage = {
  readonly requestId: string;
  readonly text: string;
  readonly createdAt: number;
  /** `sending`: not acknowledged yet (or offline). `accepted`: the daemon has it durably. */
  readonly state: "sending" | "accepted" | "failed";
  readonly error?: string;
  readonly whenBusy: WhenBusy;
};

export type TranscriptItem =
  /** Older entries exist and are not loaded. */
  | { readonly kind: "earlier" }
  /** Entries between two loaded ones are missing (after a long disconnect). */
  | { readonly kind: "gap"; readonly gap: Gap }
  | { readonly kind: "entry"; readonly entry: Entry };

export type ConversationStatus =
  /** Nothing to show yet. */
  | "loading"
  /** Following the daemon. */
  | "live"
  /** Showing what we had; reconnecting. */
  | "stale";

export type ConversationSnapshot = {
  readonly id: BotId;
  readonly status: ConversationStatus;
  readonly items: readonly TranscriptItem[];
  /** Messages the daemon has queued for this bot. */
  readonly inbox: readonly QueuedMessage[];
  readonly pending: readonly PendingMessage[];
  /** Bumped on every change; handy for memo keys and perf counters. */
  readonly revision: number;
};

/** What a client keeps on disk per bot, to open instantly and to resume with `after`. */
export type ConversationCache = {
  readonly version: 2;
  readonly entries: readonly Entry[];
  readonly gaps: readonly Gap[];
  readonly earlier: boolean;
  readonly inbox: readonly QueuedMessage[];
};

const PAGE = 50;
const CACHE_ENTRIES = 200;

function newRequestId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export class ConversationSync {
  readonly id: BotId;
  readonly #connection: Connection;
  readonly #clientId: string;
  readonly #listeners = new Set<() => void>();
  readonly #itemOf = new WeakMap<Entry, TranscriptItem>();

  /** Ascending by seq, no duplicates. */
  #entries: Entry[] = [];
  #gaps: Gap[] = [];
  #earlier = false;
  /** Whether `#entries` reflects the daemon (from a sync or the cache), so `after` can be sent. */
  #known = false;
  #inbox: readonly QueuedMessage[] = [];
  #pending: PendingMessage[] = [];
  #retained = 0;
  #watching = false;
  #snapshot: ConversationSnapshot;

  constructor(id: BotId, connection: Connection, clientId: string) {
    this.id = id;
    this.#connection = connection;
    this.#clientId = clientId;
    this.#snapshot = { id, status: "loading", items: [], inbox: [], pending: [], revision: 0 };
  }

  // ── React-friendly store surface (useSyncExternalStore) ───────────────────────

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getSnapshot = (): ConversationSnapshot => this.#snapshot;

  /** The newest entry held, the one a reconnect resumes after. */
  get newestSeq(): Seq | undefined {
    return this.#entries.at(-1)?.seq;
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────────

  get retained() {
    return this.#retained > 0;
  }

  retain() {
    if (this.#retained++ === 0) this.attach();
  }

  release() {
    if (--this.#retained > 0) return;
    if (this.#watching) this.#connection.send({ t: "unwatch", bot: this.id });
    this.#watching = false;
  }

  /** (Re)attach after a connect: ask only for what's newer than what we hold. */
  attach() {
    if (this.#retained === 0 || this.#connection.status !== "open") return;
    const after = this.#known ? (this.newestSeq ?? 0) : undefined;
    this.#watching = this.#connection.send({ t: "watch", bot: this.id, ...(after === undefined ? {} : { after }) });
    this.#resendUnacknowledged();
  }

  disconnected() {
    this.#watching = false;
    if (this.#snapshot.status === "live") this.#publish("stale");
  }

  // ── local cache ───────────────────────────────────────────────────────────────

  exportCache(): ConversationCache | undefined {
    if (!this.#known) return undefined;
    const entries = this.#entries.slice(-CACHE_ENTRIES);
    const cut = entries[0]?.seq ?? 0;
    return {
      version: 2,
      entries,
      gaps: this.#gaps.filter((g) => g.after >= cut),
      earlier: this.#earlier || entries.length < this.#entries.length || this.#gaps.some((g) => g.after < cut),
      inbox: this.#inbox,
    };
  }

  /** Show a cached copy before the daemon answers; it renders as `stale` until the sync arrives. */
  hydrate(cache: ConversationCache) {
    if (this.#known || cache.version !== 2) return;
    this.#entries = [...cache.entries];
    this.#gaps = [...cache.gaps];
    this.#earlier = cache.earlier;
    this.#inbox = cache.inbox;
    this.#known = true;
    this.#publish("stale");
  }

  /** Forget everything held: it came from another daemon. Messages still being sent stay. */
  reset() {
    this.#entries = [];
    this.#gaps = [];
    this.#earlier = false;
    this.#inbox = [];
    this.#known = false;
    this.#publish("loading");
  }

  // ── frames from the daemon ───────────────────────────────────────────────────

  receiveSync(frame: { entries: readonly Entry[]; gap?: Gap; earlier?: boolean; inbox: readonly QueuedMessage[] }) {
    if (!this.#known) this.#earlier = frame.earlier === true;
    if (frame.gap) this.#gaps.push(frame.gap);
    this.#merge(frame.entries);
    this.#known = true;
    this.#inbox = frame.inbox;
    this.#retirePending();
    this.#publish("live");
  }

  receiveEntry(entry: Entry) {
    this.#merge([entry]);
    this.#retirePending();
    this.#publish();
  }

  receiveInbox(items: readonly QueuedMessage[]) {
    this.#inbox = items;
    this.#retirePending();
    this.#publish();
  }

  // ── history ──────────────────────────────────────────────────────────────────

  async loadEarlier() {
    const first = this.#entries[0];
    if (!this.#earlier || !first) return;
    const page = await this.#connection.request<HistoryResult>({ t: "history", bot: this.id, before: first.seq, limit: PAGE });
    this.#earlier = page.more;
    this.#merge(page.entries);
    this.#publish();
  }

  async fillGap(gap: Gap) {
    const page = await this.#connection.request<HistoryResult>({ t: "history", bot: this.id, before: gap.before, after: gap.after, limit: PAGE });
    const lowest = page.entries[0]?.seq;
    this.#gaps = this.#gaps.flatMap((g) => {
      if (g.after !== gap.after || g.before !== gap.before) return [g];
      return page.more && lowest !== undefined ? [{ after: g.after, before: lowest }] : [];
    });
    this.#merge(page.entries);
    this.#publish();
  }

  /** One entry in full: untruncated tool output, thinking, tool arguments. */
  detail(seq: Seq): Promise<Entry> {
    return this.#connection.request<Entry>({ t: "detail", bot: this.id, seq });
  }

  // ── actions ───────────────────────────────────────────────────────────────────

  send(text: string, whenBusy: WhenBusy = "followUp"): PendingMessage {
    const message: PendingMessage = { requestId: newRequestId(), text, createdAt: Date.now(), state: "sending", whenBusy };
    this.#pending = [...this.#pending, message];
    this.#publish();
    this.#submit(message);
    return message;
  }

  retry(requestId: string) {
    const message = this.#pending.find((p) => p.requestId === requestId);
    if (message) this.#submit(this.#update(requestId, { state: "sending", error: undefined })!);
  }

  discard(requestId: string) {
    this.#pending = this.#pending.filter((p) => p.requestId !== requestId);
    this.#publish();
  }

  async abort() {
    await this.#connection.request({ t: "abort", bot: this.id });
  }

  // ── internals ────────────────────────────────────────────────────────────────

  #merge(incoming: readonly Entry[]) {
    if (!incoming.length) return;
    const last = this.#entries.at(-1);
    if (!last || incoming[0]!.seq > last.seq) {
      // The common case: newer entries, already in order.
      this.#entries = this.#entries.concat(incoming);
    } else {
      const bySeq = new Map(this.#entries.map((e) => [e.seq, e]));
      for (const entry of incoming) if (!bySeq.has(entry.seq)) bySeq.set(entry.seq, entry);
      this.#entries = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
    }
  }

  #items(): TranscriptItem[] {
    const items: TranscriptItem[] = [];
    if (this.#earlier) items.push(EARLIER);
    const gaps = [...this.#gaps].sort((a, b) => a.before - b.before);
    let g = 0;
    for (const entry of this.#entries) {
      while (g < gaps.length && gaps[g]!.before <= entry.seq) items.push({ kind: "gap", gap: gaps[g++]! });
      let item = this.#itemOf.get(entry);
      if (!item) this.#itemOf.set(entry, (item = { kind: "entry", entry }));
      items.push(item);
    }
    return items;
  }

  /** Drop pending copies the daemon now has (queued or placed). */
  #retirePending() {
    if (!this.#pending.length) return;
    const known = new Set(this.#inbox.map((q) => q.requestId));
    for (let i = this.#entries.length - 1, n = 0; i >= 0 && n < 200; i--, n++) {
      const entry = this.#entries[i]!;
      if (entry.kind === "user" && entry.requestId) known.add(entry.requestId);
    }
    const kept = this.#pending.filter((p) => !known.has(p.requestId));
    if (kept.length !== this.#pending.length) this.#pending = kept;
  }

  #publish(status: ConversationStatus = this.#snapshot.status) {
    const items = this.#items();
    const previous = this.#snapshot;
    this.#snapshot = {
      id: this.id,
      status: status === "loading" && this.#known ? "stale" : status,
      items: sameItems(previous.items, items) ? previous.items : items,
      inbox: this.#inbox,
      pending: this.#pending,
      revision: previous.revision + 1,
    };
    for (const listener of this.#listeners) listener();
  }

  #update(requestId: string, change: Partial<PendingMessage>): PendingMessage | undefined {
    let updated: PendingMessage | undefined;
    this.#pending = this.#pending.map((p) => (p.requestId === requestId ? (updated = { ...p, ...change }) : p));
    if (updated) this.#publish();
    return updated;
  }

  #submit(message: PendingMessage) {
    if (this.#connection.status !== "open") return; // resent on reconnect
    this.#connection
      .request<SubmitResult>({
        t: "submit",
        bot: this.id,
        requestId: message.requestId,
        text: message.text,
        whenBusy: message.whenBusy,
        clientId: this.#clientId,
      })
      .then(
        () => {
          // The daemon has it durably. It shows as queued or placed once the inbox or entry frame lands.
          this.#retirePending();
          if (this.#pending.some((p) => p.requestId === message.requestId)) this.#update(message.requestId, { state: "accepted" });
          else this.#publish();
        },
        (error: Error) => {
          // A dropped connection is not a failure: the message stays "sending" and goes out again on reconnect.
          if (error.name === "OfflineError") return;
          // No answer in time: the daemon may or may not have it. Resending is safe, the requestId dedupes it.
          if (error.name === "TimeoutError") {
            setTimeout(() => this.#pending.some((p) => p.requestId === message.requestId) && this.#submit(message), 1_000);
            return;
          }
          this.#update(message.requestId, { state: "failed", error: error.message });
        },
      );
  }

  #resendUnacknowledged() {
    for (const message of this.#pending) if (message.state === "sending") this.#submit(message);
  }
}

const EARLIER: TranscriptItem = { kind: "earlier" };

function sameItems(a: readonly TranscriptItem[], b: readonly TranscriptItem[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x === y) continue;
    if (x.kind === "gap" && y.kind === "gap" && x.gap.after === y.gap.after && x.gap.before === y.gap.before) continue;
    return false;
  }
  return true;
}
