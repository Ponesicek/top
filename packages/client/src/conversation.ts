/**
 * A client's copy of one bot conversation.
 *
 * - The daemon sends the view once, then Chord ops. Ops are decoded as they arrive (the decoder is
 *   stateful) but applied once per frame, so a bot streaming 100 tokens/s costs one render per frame.
 * - Pi Durable's `ConversationTranscript` keeps every entry the client has seen beyond the view's
 *   window, marks gaps after a stall or reconnect, and pages history through the socket.
 * - Messages the user sends show up instantly as pending, survive a dropped connection, and are
 *   resent with the same `requestId` (applied once by the daemon) until the real entry lands.
 */
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { applyImmutableBatches, decoder, type Decoder, type Op } from "@earendil-works/chord/delta";
import type { ConversationView, EntryRecord, InboxState, LiveState } from "@earendil-works/pi-durable";
import {
  ConversationTranscript,
  type TranscriptItem,
  type TranscriptView,
} from "@earendil-works/pi-durable/transcript";
import { MESSAGE_KIND, type MessageData, type WhenBusy, type WireId, type WireOp } from "@top/protocol";
import type { Connection } from "./connection.ts";

export type { TranscriptItem, TranscriptView, LiveState, InboxState, EntryRecord, ConversationView };

export type PendingMessage = {
  readonly requestId: string;
  readonly text: string;
  readonly createdAt: number;
  /** `sending`: not acknowledged yet (or offline). `accepted`: the daemon has it durably; waiting for it to be placed. */
  readonly state: "sending" | "accepted" | "failed";
  readonly error?: string;
  readonly whenBusy: WhenBusy;
};

export type ConversationStatus =
  /** No view yet. */
  | "loading"
  /** Following the daemon. */
  | "live"
  /** Showing what we had; reconnecting. */
  | "stale";

export type ConversationSnapshot = {
  readonly id: WireId;
  readonly status: ConversationStatus;
  readonly items: readonly TranscriptItem[];
  readonly live: LiveState | undefined;
  readonly inbox: InboxState | undefined;
  readonly pending: readonly PendingMessage[];
  /** Bumped on every applied change; handy for memo keys and perf counters. */
  readonly revision: number;
};

export type Scheduler = (flush: () => void) => void;

export const frameScheduler: Scheduler =
  typeof requestAnimationFrame === "function" ? (flush) => requestAnimationFrame(() => flush()) : (flush) => setTimeout(flush, 16);

function newRequestId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** The requestIds that are in the transcript or queued in the daemon's inbox. */
function placedRequestIds(items: readonly TranscriptItem[], inbox: InboxState | undefined, since: number): Set<string> {
  const ids = new Set<string>();
  for (let i = items.length - 1; i >= since; i--) {
    const item = items[i]!;
    if (item.kind === "entry" && item.entry.kind === MESSAGE_KIND) ids.add((item.entry.data as MessageData).requestId);
  }
  for (const queued of inbox?.items ?? []) {
    const data = (queued.entry as { kind?: string; data?: MessageData } | undefined)?.data;
    if (queued.entry?.kind === MESSAGE_KIND && data) ids.add(data.requestId);
  }
  return ids;
}

export class ConversationSync {
  readonly id: WireId;
  readonly #connection: Connection;
  readonly #clientId: string;
  readonly #schedule: Scheduler;
  readonly #transcript: ConversationTranscript;
  readonly #listeners = new Set<() => void>();
  readonly #context: Context = BACKGROUND_CONTEXT;

  #sub = 0;
  #decoder: Decoder = decoder();
  #view: ConversationView | undefined;
  #batches: Op[][] = [];
  #flushScheduled = false;
  #pending: PendingMessage[] = [];
  #retained = 0;
  #snapshot: ConversationSnapshot;

  /** Called with each newly allocated subscription id, so the client can route frames. */
  onSubscribe: (sub: number) => void = () => {};
  allocateSub: () => number = () => 0;

  constructor(id: WireId, connection: Connection, clientId: string, schedule: Scheduler) {
    this.id = id;
    this.#connection = connection;
    this.#clientId = clientId;
    this.#schedule = schedule;
    this.#transcript = new ConversationTranscript(
      (query, limit) =>
        connection.request({ t: "entries", conversationId: id, query: query as never, limit }) as never,
      { pageSize: 50 },
    );
    this.#snapshot = { id, status: "loading", items: [], live: undefined, inbox: undefined, pending: [], revision: 0 };
  }

  // ── React-friendly store surface (useSyncExternalStore) ───────────────────────

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getSnapshot = (): ConversationSnapshot => this.#snapshot;

  // ── lifecycle ─────────────────────────────────────────────────────────────────

  get sub() {
    return this.#sub;
  }
  get retained() {
    return this.#retained > 0;
  }

  retain() {
    if (this.#retained++ === 0) this.attach();
  }

  release() {
    if (--this.#retained > 0) return;
    if (this.#sub) this.#connection.send({ t: "unwatch", sub: this.#sub });
    this.#sub = 0;
  }

  /** (Re)attach after a connect: resume from the newest entry this client has. */
  attach() {
    if (this.#retained === 0 || this.#connection.status !== "open") return;
    if (this.#sub) this.#connection.send({ t: "unwatch", sub: this.#sub });
    this.#sub = this.allocateSub();
    this.#decoder = decoder();
    this.#batches = [];
    this.onSubscribe(this.#sub);
    const window = this.#transcript.resume;
    this.#connection.send({ t: "watch", sub: this.#sub, conversationId: this.id, window: window as never });
    this.#resendUnacknowledged();
  }

  disconnected() {
    this.#sub = 0;
    this.#batches = [];
    this.#publish({ status: this.#view ? "stale" : "loading" });
  }

  // ── local cache ───────────────────────────────────────────────────────────────

  /** The raw view this client follows (a window of at most ~100 entries plus docs), to persist locally. */
  exportView(): ConversationView | undefined {
    return this.#view;
  }

  /**
   * Show a cached view before the daemon answers. It renders as `stale`; once connected, the watch
   * resumes right after its newest entry, so only what changed since is sent.
   */
  hydrate(view: ConversationView) {
    if (this.#view) return;
    this.#view = view;
    this.#adopt(this.#transcript.merge(view), "stale");
  }

  // ── frames from the daemon ───────────────────────────────────────────────────

  receiveView(sub: number, value: unknown) {
    if (sub !== this.#sub) return;
    this.#view = value as ConversationView;
    this.#batches = [];
    this.#scheduleFlush(true);
  }

  receiveOps(sub: number, ops: readonly WireOp[]) {
    if (sub !== this.#sub) return;
    this.#batches.push(this.#decoder.decode(ops as unknown[]));
    this.#scheduleFlush();
  }

  receiveEnd(sub: number) {
    if (sub !== this.#sub) return;
    this.#sub = 0;
    this.#publish({ status: "stale" });
    // The watch ended without the socket closing (for example the daemon restarted a conversation): attach again.
    setTimeout(() => this.attach(), 250);
  }

  #scheduleFlush(immediate = false) {
    if (this.#flushScheduled) return;
    this.#flushScheduled = true;
    const run = () => {
      this.#flushScheduled = false;
      this.#flush();
    };
    if (immediate) queueMicrotask(run);
    else this.#schedule(run);
  }

  #flush() {
    if (!this.#view) return;
    if (this.#batches.length) {
      this.#view = applyImmutableBatches(this.#view, this.#batches);
      this.#batches = [];
    }
    this.#adopt(this.#transcript.merge(this.#view), "live");
  }

  #adopt(view: TranscriptView, status: ConversationStatus = this.#snapshot.status) {
    const live = view.docs["pi.live"] as LiveState | undefined;
    const inbox = view.docs["pi.inbox"] as InboxState | undefined;
    let pending = this.#pending;
    if (pending.length) {
      // Only the tail can hold a just-placed message; don't rescan a 10k-entry history each frame.
      const placed = placedRequestIds(view.items, inbox, Math.max(0, view.items.length - 200));
      const kept = pending.filter((p) => !placed.has(p.requestId));
      if (kept.length !== pending.length) pending = this.#pending = kept;
    }
    this.#publish({ status, items: view.items, live, inbox, pending });
  }

  #publish(change: Partial<Omit<ConversationSnapshot, "id" | "revision">>) {
    this.#snapshot = { ...this.#snapshot, ...change, revision: this.#snapshot.revision + 1 };
    for (const listener of this.#listeners) listener();
  }

  // ── actions ───────────────────────────────────────────────────────────────────

  send(text: string, whenBusy: WhenBusy = "followUp"): PendingMessage {
    const message: PendingMessage = { requestId: newRequestId(), text, createdAt: Date.now(), state: "sending", whenBusy };
    this.#pending = [...this.#pending, message];
    this.#publish({ pending: this.#pending });
    this.#submit(message);
    return message;
  }

  retry(requestId: string) {
    const message = this.#pending.find((p) => p.requestId === requestId);
    if (message) this.#submit(this.#update(requestId, { state: "sending", error: undefined })!);
  }

  discard(requestId: string) {
    this.#pending = this.#pending.filter((p) => p.requestId !== requestId);
    this.#publish({ pending: this.#pending });
  }

  async abort() {
    await this.#connection.request({ t: "abort", conversationId: this.id });
  }

  async loadEarlier() {
    this.#adopt(await this.#transcript.loadEarlier(this.#context));
  }

  async fillGap(gap: Extract<TranscriptItem, { kind: "gap" }>) {
    this.#adopt(await this.#transcript.fillGap(gap, this.#context));
  }

  #update(requestId: string, change: Partial<PendingMessage>): PendingMessage | undefined {
    let updated: PendingMessage | undefined;
    this.#pending = this.#pending.map((p) => (p.requestId === requestId ? (updated = { ...p, ...change }) : p));
    if (updated) this.#publish({ pending: this.#pending });
    return updated;
  }

  #submit(message: PendingMessage) {
    if (this.#connection.status !== "open") return; // resent on reconnect
    this.#connection
      .request({
        t: "submit",
        conversationId: this.id,
        requestId: message.requestId,
        content: message.text,
        whenBusy: message.whenBusy,
        clientId: this.#clientId,
      })
      .then(
        () => {
          // Still pending if the entry hasn't landed in a frame yet; the next flush retires it.
          if (this.#pending.some((p) => p.requestId === message.requestId)) this.#update(message.requestId, { state: "accepted" });
        },
        (error: Error) => {
          // A dropped connection is not a failure: the message stays "sending" and goes out again on reconnect.
          if (error.name === "OfflineError") return;
          // No answer in time: the daemon may or may not have it. Resending is safe, the requestId dedupes it.
          if (error.name === "TimeoutError") {
            setTimeout(() => this.#pending.includes(message) && this.#submit(message), 1_000);
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
