/**
 * @top/client: everything a Top UI needs except the pixels. Framework-free TypeScript, shared by the
 * Electron desktop app and the React Native app.
 *
 *   const top = new TopClient({ url: "ws://127.0.0.1:7357" });
 *   const bot = top.conversation(id); bot.retain();
 *   useSyncExternalStore(bot.subscribe, bot.getSnapshot);
 */
import type { BotSummary, ServerFrame, WireId } from "@top/protocol";
import { Connection, type ConnectionStatus } from "./connection.ts";
import { ConversationSync, frameScheduler, type Scheduler } from "./conversation.ts";

export * from "./conversation.ts";
export { Connection, OfflineError, TimeoutError, type ConnectionStatus } from "./connection.ts";
export type { BotSummary, BotStatus, WhenBusy, WireId } from "@top/protocol";
export { MESSAGE_KIND, type MessageData } from "@top/protocol";

export type TopClientOptions = {
  readonly url: string;
  readonly clientId?: string;
  readonly WebSocket?: typeof WebSocket;
  readonly schedule?: Scheduler;
};

export type TopSnapshot = {
  readonly connection: ConnectionStatus;
  readonly rttMs: number | undefined;
  readonly attempt: number;
  readonly bots: readonly BotSummary[];
  /** Set once the first roster arrived; the UI can render from cache before that. */
  readonly ready: boolean;
};

export class TopClient {
  readonly clientId: string;
  readonly #connection: Connection;
  readonly #schedule: Scheduler;
  readonly #conversations = new Map<string, ConversationSync>();
  readonly #bySub = new Map<number, ConversationSync>();
  readonly #listeners = new Set<() => void>();
  #nextSub = 1;
  readonly #rttTimer: ReturnType<typeof setInterval>;
  #snapshot: TopSnapshot = { connection: "connecting", rttMs: undefined, attempt: 0, bots: [], ready: false };

  constructor(options: TopClientOptions) {
    this.clientId = options.clientId ?? `client-${Math.random().toString(36).slice(2, 10)}`;
    this.#schedule = options.schedule ?? frameScheduler;
    this.#connection = new Connection({ url: options.url, clientId: this.clientId, WebSocket: options.WebSocket });
    this.#connection.onFrame = (frame) => this.#receive(frame);
    this.#connection.onOpen = () => {
      this.#bySub.clear();
      for (const conversation of this.#conversations.values()) conversation.attach();
    };
    this.#connection.onStatus = () => {
      if (this.#connection.status !== "open") {
        this.#bySub.clear();
        for (const conversation of this.#conversations.values()) conversation.disconnected();
      }
      this.#publish({ connection: this.#connection.status, attempt: this.#connection.attempt });
    };
    this.#connection.start();
    // RTT is read lazily; refresh it in the snapshot now and then without a render per pong.
    this.#rttTimer = setInterval(() => {
      if (this.#connection.rttMs !== this.#snapshot.rttMs) this.#publish({ rttMs: this.#connection.rttMs });
    }, 2_000);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getSnapshot = (): TopSnapshot => this.#snapshot;

  /** Show a cached roster before the daemon answers. */
  hydrateBots(bots: readonly BotSummary[]) {
    if (!this.#snapshot.ready && this.#snapshot.bots.length === 0) this.#publish({ bots });
  }

  /** Reconnect now (for example on the browser's `online` event or when the app returns to the foreground). */
  kick() {
    this.#connection.kick();
  }

  conversation(id: WireId): ConversationSync {
    const key = String(id);
    let conversation = this.#conversations.get(key);
    if (!conversation) {
      conversation = new ConversationSync(id, this.#connection, this.clientId, this.#schedule);
      conversation.allocateSub = () => this.#nextSub++;
      const c = conversation;
      conversation.onSubscribe = (sub) => this.#bySub.set(sub, c);
      this.#conversations.set(key, conversation);
    }
    return conversation;
  }

  close() {
    clearInterval(this.#rttTimer);
    this.#connection.close();
  }

  #receive(frame: ServerFrame) {
    switch (frame.t) {
      case "bots":
        this.#publish({ bots: frame.bots, ready: true });
        return;
      case "view":
        this.#bySub.get(frame.sub)?.receiveView(frame.sub, frame.value);
        return;
      case "ops":
        this.#bySub.get(frame.sub)?.receiveOps(frame.sub, frame.ops);
        return;
      case "end":
        this.#bySub.get(frame.sub)?.receiveEnd(frame.sub);
        this.#bySub.delete(frame.sub);
        return;
    }
  }

  #publish(change: Partial<TopSnapshot>) {
    this.#snapshot = { ...this.#snapshot, ...change };
    for (const listener of this.#listeners) listener();
  }
}
