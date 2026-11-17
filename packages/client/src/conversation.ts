import { type Attachment, type BotId, Entry, Gap, QueuedMessage, type Seq, type WhenBusy } from "@top/protocol";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { Connection } from "./connection.ts";

export type ClientRuntime = {
  readonly promise: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
  readonly fork: <A, E>(effect: Effect.Effect<A, E>) => void;
};

export type PendingMessage = {
  readonly requestId: string;
  readonly text: string;
  readonly attachments?: readonly Attachment[];
  readonly createdAt: number;
  readonly state: "sending" | "accepted" | "failed";
  readonly error?: string | undefined;
  readonly whenBusy: WhenBusy;
};

export type TranscriptItem = { readonly kind: "earlier" } | { readonly kind: "gap"; readonly gap: Gap } | { readonly kind: "entry"; readonly entry: Entry };

export type ConversationStatus = "loading" | "live" | "stale";

export type ConversationSnapshot = {
  readonly id: BotId;
  readonly status: ConversationStatus;
  readonly items: readonly TranscriptItem[];
  readonly inbox: readonly QueuedMessage[];
  readonly pending: readonly PendingMessage[];
  readonly revision: number;
};

export const ConversationCache = Schema.Struct({
  version: Schema.Literal(2),
  entries: Schema.Array(Entry),
  gaps: Schema.Array(Gap),
  earlier: Schema.Boolean,
  inbox: Schema.Array(QueuedMessage),
});
export type ConversationCache = typeof ConversationCache.Type;

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
  readonly #run: ClientRuntime;
  readonly #listeners = new Set<() => void>();
  readonly #itemOf = new WeakMap<Entry, TranscriptItem>();

  #entries: Entry[] = [];
  #gaps: Gap[] = [];
  #earlier = false;
  #known = false;
  #inbox: readonly QueuedMessage[] = [];
  #pending: PendingMessage[] = [];
  #retained = 0;
  #watching = false;
  #snapshot: ConversationSnapshot;

  constructor(id: BotId, connection: Connection, clientId: string, run: ClientRuntime) {
    this.id = id;
    this.#connection = connection;
    this.#clientId = clientId;
    this.#run = run;
    this.#snapshot = { id, status: "loading", items: [], inbox: [], pending: [], revision: 0 };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getSnapshot = (): ConversationSnapshot => this.#snapshot;

  get newestSeq(): Seq | undefined {
    return this.#entries.at(-1)?.seq;
  }

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

  attach() {
    if (this.#retained === 0 || this.#connection.status() !== "open") return;
    const after = this.#known ? (this.newestSeq ?? 0) : undefined;
    this.#watching = this.#connection.send({ t: "watch", bot: this.id, ...(after === undefined ? {} : { after }) });
    this.#resendUnacknowledged();
  }

  disconnected() {
    this.#watching = false;
    if (this.#snapshot.status === "live") this.#publish("stale");
  }

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

  hydrate(cache: ConversationCache) {
    if (this.#known || cache.version !== 2) return;
    this.#entries = [...cache.entries];
    this.#gaps = [...cache.gaps];
    this.#earlier = cache.earlier;
    this.#inbox = cache.inbox;
    this.#known = true;
    this.#publish("stale");
  }

  reset() {
    this.#entries = [];
    this.#gaps = [];
    this.#earlier = false;
    this.#inbox = [];
    this.#known = false;
    this.#publish("loading");
  }

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

  loadEarlier(): Promise<void> {
    const first = this.#entries[0];
    if (!this.#earlier || !first) return Promise.resolve();
    return this.#run.promise(
      Effect.map(this.#connection.request({ t: "history", bot: this.id, before: first.seq, limit: PAGE }), (page) => {
        this.#earlier = page.more;
        this.#merge(page.entries);
        this.#publish();
      }),
    );
  }

  fillGap(gap: Gap): Promise<void> {
    return this.#run.promise(
      Effect.map(this.#connection.request({ t: "history", bot: this.id, before: gap.before, after: gap.after, limit: PAGE }), (page) => {
        const lowest = page.entries[0]?.seq;
        this.#gaps = this.#gaps.flatMap((g) => {
          if (g.after !== gap.after || g.before !== gap.before) return [g];
          return page.more && lowest !== undefined ? [{ after: g.after, before: lowest }] : [];
        });
        this.#merge(page.entries);
        this.#publish();
      }),
    );
  }

  detail(seq: Seq): Promise<Entry | null> {
    return this.#run.promise(this.#connection.request({ t: "detail", bot: this.id, seq }));
  }

  send(text: string, whenBusy: WhenBusy = "followUp", attachments: readonly Attachment[] = []): PendingMessage {
    const message: PendingMessage = {
      requestId: newRequestId(),
      text,
      ...(attachments.length ? { attachments } : {}),
      createdAt: Date.now(),
      state: "sending",
      whenBusy,
    };
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

  abort(): Promise<void> {
    return this.#run.promise(Effect.asVoid(this.#connection.request({ t: "abort", bot: this.id })));
  }

  #merge(incoming: readonly Entry[]) {
    if (!incoming.length) return;
    const last = this.#entries.at(-1);
    if (!last || incoming[0]!.seq > last.seq) {
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
      if (!item) {
        item = { kind: "entry", entry };
        this.#itemOf.set(entry, item);
      }
      items.push(item);
    }
    return items;
  }

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
    this.#pending = this.#pending.map((p) => {
      if (p.requestId !== requestId) return p;
      updated = { ...p, ...change };
      return updated;
    });
    if (updated) this.#publish();
    return updated;
  }

  #submit(message: PendingMessage) {
    if (this.#connection.status() !== "open") return;
    const stillPending = () => this.#pending.some((p) => p.requestId === message.requestId);
    this.#run.fork(
      this.#connection
        .request({
          t: "submit",
          bot: this.id,
          requestId: message.requestId,
          text: message.text,
          ...(message.attachments?.length ? { attachments: message.attachments.map((a) => a.id) } : {}),
          whenBusy: message.whenBusy,
          clientId: this.#clientId,
        })
        .pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              this.#retirePending();
              if (stillPending()) this.#update(message.requestId, { state: "accepted" });
              else this.#publish();
            }),
          ),
          Effect.catchTags({
            OfflineError: () => Effect.void,
            TimeoutError: () => Effect.sleep(Duration.seconds(1)).pipe(Effect.andThen(Effect.sync(() => stillPending() && this.#submit(message)))),
          }),
          Effect.catch((error) => Effect.sync(() => this.#update(message.requestId, { state: "failed", error: error.message }))),
        ),
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
