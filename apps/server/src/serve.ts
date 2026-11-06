/**
 * One WebSocket per client, compressed with permessage-deflate.
 *
 * Every client gets the bot summaries once, then one small frame per bot that changed. A client
 * watches the bots it shows: `watch` answers with only the entries it is missing, then each new
 * entry is pushed once. Reading and registering happen in the same tick (SQLite is synchronous), so
 * no entry can slip between the catch-up and the live updates.
 */
import { PROTOCOL_VERSION, type ClientFrame, type Entry, type QueuedMessage, type ServerFrame } from "@top/protocol";
import { WebSocketServer, type WebSocket } from "ws";
import type { Daemon } from "./daemon.ts";
import { toWire } from "./wire.ts";

const HEARTBEAT_MS = 30_000;
const DEFAULT_WINDOW = 50;
const MAX_WINDOW = 200;
/** A client this far behind is reading nothing; drop it and let it resync on reconnect. */
const MAX_BUFFERED = 8 << 20;

function send(socket: WebSocket, frame: ServerFrame) {
  if (socket.readyState !== socket.OPEN) return;
  if (socket.bufferedAmount > MAX_BUFFERED) return socket.terminate();
  socket.send(JSON.stringify(frame));
}

const wire = (entries: readonly Parameters<typeof toWire>[0][]): Entry[] => entries.flatMap((e) => toWire(e) ?? []);

function inboxOf(daemon: Daemon, bot: number): QueuedMessage[] {
  return daemon.store.inbox(bot).map((row) => ({ requestId: row.requestId, text: row.text, mode: row.mode, at: row.at }));
}

class ClientConnection {
  readonly socket: WebSocket;
  readonly #daemon: Daemon;
  readonly #watching = new Set<number>();
  readonly #unsubscribe: (() => void)[];
  /** The client's entries are from another daemon's data, so its `after` positions mean nothing here. */
  #foreign = false;
  alive = true;

  constructor(socket: WebSocket, daemon: Daemon) {
    this.socket = socket;
    this.#daemon = daemon;
    socket.on("message", (data) => this.#receive(String(data)));
    socket.on("pong", () => (this.alive = true));
    socket.on("close", () => this.close());
    send(socket, { t: "welcome", serverId: daemon.store.id, protocol: PROTOCOL_VERSION });
    send(socket, { t: "bots", bots: daemon.bots });
    this.#unsubscribe = [
      daemon.onBot((bot) => send(socket, { t: "bot", bot })),
      daemon.onBotRemoved((bot) => {
        this.#watching.delete(bot);
        send(socket, { t: "botRemoved", bot });
      }),
      daemon.onEntry((stored) => {
        if (!this.#watching.has(stored.bot)) return;
        const entry = toWire(stored);
        if (entry) send(socket, { t: "entry", entry });
      }),
      daemon.onInbox((bot) => {
        if (this.#watching.has(bot)) send(socket, { t: "inbox", bot, items: inboxOf(daemon, bot) });
      }),
    ];
  }

  #receive(text: string) {
    let frame: ClientFrame;
    try {
      frame = JSON.parse(text) as ClientFrame;
    } catch {
      return;
    }
    const store = this.#daemon.store;
    switch (frame.t) {
      case "hello":
        this.#foreign = frame.serverId !== undefined && frame.serverId !== store.id;
        return;
      case "ping":
        return send(this.socket, { t: "pong", at: frame.at });
      case "watch": {
        if (!this.#daemon.runners.has(frame.bot)) return;
        const limit = Math.min(Math.max(1, frame.limit ?? DEFAULT_WINDOW), MAX_WINDOW);
        let entries;
        let gap;
        let earlier;
        const after = this.#foreign ? undefined : frame.after;
        if (after === undefined) {
          entries = store.newest(frame.bot, limit);
          earlier = entries.length > 0 && store.hasBefore(frame.bot, entries[0]!.seq);
        } else {
          entries = store.after(frame.bot, after, limit + 1);
          if (entries.length > limit) {
            // Missed more than fit: send the newest, and say what lies between.
            entries = store.newest(frame.bot, limit);
            gap = { after, before: entries[0]!.seq };
          }
        }
        this.#watching.add(frame.bot);
        return send(this.socket, {
          t: "sync",
          bot: frame.bot,
          entries: wire(entries),
          ...(gap ? { gap } : {}),
          ...(earlier ? { earlier: true } : {}),
          inbox: inboxOf(this.#daemon, frame.bot),
        });
      }
      case "unwatch":
        this.#watching.delete(frame.bot);
        return;
      case "history":
        return this.#answer(frame.req, () => {
          const limit = Math.min(Math.max(1, frame.limit), MAX_WINDOW);
          const { entries, more } = store.history(frame.bot, frame.before, frame.after ?? 0, limit);
          return { entries: wire(entries), more };
        });
      case "detail":
        return this.#answer(frame.req, () => {
          const stored = store.entry(frame.seq);
          if (!stored || stored.bot !== frame.bot) throw new Error(`No entry ${frame.seq}`);
          return toWire(stored, true) ?? null;
        });
      case "submit":
        return this.#answer(frame.req, () => this.#daemon.submit(frame.bot, frame.requestId, frame.text, frame.whenBusy, frame.clientId));
      case "abort":
        return this.#answer(frame.req, () => {
          this.#daemon.runner(frame.bot).abort();
          return null;
        });
      case "createBot":
        return this.#answer(frame.req, () => ({ id: this.#daemon.createBot(String(frame.name ?? ""), String(frame.description ?? "")) }));
      case "deleteBot":
        return this.#answer(frame.req, () => {
          this.#daemon.deleteBot(frame.bot);
          return null;
        });
    }
  }

  #answer(req: number, run: () => unknown) {
    try {
      send(this.socket, { t: "result", req, ok: true, value: run() });
    } catch (error) {
      send(this.socket, { t: "result", req, ok: false, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
    }
  }

  close() {
    for (const unsubscribe of this.#unsubscribe.splice(0)) unsubscribe();
    this.#watching.clear();
  }
}

/**
 * Browsers let any web page open a WebSocket to localhost, and the bots can run commands, so a browser
 * connection is accepted only from the app itself: the Electron build (`file://`) and the dev/web UI
 * (`pnpm desktop`, `pnpm web` on :5199). Native clients (Node, the phone app) send no Origin.
 */
export const APP_ORIGINS = ["file://", "null", "http://localhost:5199", "http://127.0.0.1:5199"] as const;

export function serve(daemon: Daemon, options: { host: string; port: number; compress: boolean; allowOrigins?: readonly string[] }) {
  const allowed = new Set<string>([...APP_ORIGINS, ...(options.allowOrigins ?? [])]);
  const server = new WebSocketServer({
    host: options.host,
    port: options.port,
    verifyClient: ({ origin }: { origin?: string }) => {
      if (origin === undefined || allowed.has(origin)) return true;
      console.warn(`[top] refused a connection from ${origin} (pass --allow-origin ${origin} to allow it)`);
      return false;
    },
    // Context takeover on both sides: repeated keys and names across frames cost almost nothing.
    perMessageDeflate: options.compress ? { threshold: 64, zlibDeflateOptions: { level: 6 } } : false,
  });
  const clients = new Set<ClientConnection>();
  server.on("connection", (socket) => {
    const client = new ClientConnection(socket, daemon);
    clients.add(client);
    socket.on("close", () => clients.delete(client));
  });
  // Drop clients that stopped answering (a phone that lost its network without closing the socket).
  const heartbeat = setInterval(() => {
    for (const client of clients) {
      if (!client.alive) {
        client.socket.terminate();
        continue;
      }
      client.alive = false;
      client.socket.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();
  return {
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(heartbeat);
        for (const client of clients) client.socket.close(1001, "server shutting down");
        server.close(() => resolve());
      }),
  };
}
