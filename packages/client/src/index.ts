/**
 * @top/client: everything a Top UI needs except the pixels. Framework-free TypeScript, shared by the
 * Electron desktop app and the React Native app.
 *
 *   const top = new TopClient({ url: "ws://127.0.0.1:7357" });
 *   const bot = top.conversation(id); bot.retain();
 *   useSyncExternalStore(bot.subscribe, bot.getSnapshot);
 *
 * Retain only the bots on screen when data is metered (a phone on cellular): the sidebar summaries
 * cover the rest, and a retained bot catches up from what it holds when it is opened.
 */
import type { BotId, BotSummary, ServerFrame } from "@top/protocol";
import { Connection, type ConnectionStatus } from "./connection.ts";
import { ConversationSync } from "./conversation.ts";

export * from "./conversation.ts";
export { Connection, OfflineError, TimeoutError, type ConnectionStatus } from "./connection.ts";
export type { BotId, BotStatus, BotSummary, Entry, Gap, QueuedMessage, Seq, ToolCallView, ToolOutcome, WhenBusy } from "@top/protocol";

export type TopClientOptions = {
  readonly url: string;
  readonly clientId?: string;
  readonly WebSocket?: typeof WebSocket;
  readonly pingIntervalMs?: number;
  readonly deadAfterMs?: number;
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
  readonly #conversations = new Map<BotId, ConversationSync>();
  readonly #listeners = new Set<() => void>();
  readonly #rttTimer: ReturnType<typeof setInterval>;
  #snapshot: TopSnapshot = { connection: "connecting", rttMs: undefined, attempt: 0, bots: [], ready: false };

  constructor(options: TopClientOptions) {
    this.clientId = options.clientId ?? `client-${Math.random().toString(36).slice(2, 10)}`;
    this.#connection = new Connection({
      url: options.url,
      clientId: this.clientId,
      WebSocket: options.WebSocket,
      ...(options.pingIntervalMs ? { pingIntervalMs: options.pingIntervalMs } : {}),
      ...(options.deadAfterMs ? { deadAfterMs: options.deadAfterMs } : {}),
    });
    this.#connection.onFrame = (frame) => this.#receive(frame);
    this.#connection.onOpen = () => {
      for (const conversation of this.#conversations.values()) conversation.attach();
    };
    this.#connection.onStatus = () => {
      if (this.#connection.status !== "open") for (const conversation of this.#conversations.values()) conversation.disconnected();
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

  /**
   * The app came back to the foreground or the network changed: reconnect now if we're down, or
   * check right away that an open socket still works.
   */
  kick() {
    this.#connection.kick();
  }

  conversation(id: BotId): ConversationSync {
    let conversation = this.#conversations.get(id);
    if (!conversation) {
      conversation = new ConversationSync(id, this.#connection, this.clientId);
      this.#conversations.set(id, conversation);
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
      case "bot": {
        const bots = this.#snapshot.bots;
        const i = bots.findIndex((b) => b.id === frame.bot.id);
        this.#publish({ bots: i < 0 ? [...bots, frame.bot] : bots.map((b, j) => (j === i ? frame.bot : b)) });
        return;
      }
      case "sync":
        this.#conversations.get(frame.bot)?.receiveSync(frame);
        return;
      case "entry":
        this.#conversations.get(frame.entry.bot)?.receiveEntry(frame.entry);
        return;
      case "inbox":
        this.#conversations.get(frame.bot)?.receiveInbox(frame.items);
        return;
    }
  }

  #publish(change: Partial<TopSnapshot>) {
    this.#snapshot = { ...this.#snapshot, ...change };
    for (const listener of this.#listeners) listener();
  }
}
