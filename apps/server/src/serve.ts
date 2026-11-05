/**
 * One WebSocket per client. Each `watch` frame attaches a Pi Durable watch and forwards its
 * operations, encoded with a per-subscription Chord encoder.
 *
 * Backpressure is free: the watch listener awaits the socket draining, and Chord folds every commit
 * that lands meanwhile into the next call (past 10,000 ops it sends one replacement instead). A slow
 * phone gets fewer, bigger updates; it never makes the daemon buffer without bound.
 */
import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import { encoder } from "@earendil-works/chord/delta";
import type { ConversationWatch, Harness } from "@earendil-works/pi-durable";
import { MESSAGE_KIND, PROTOCOL_VERSION, type ClientFrame, type MessageData, type ServerFrame, type WatchWindow, type WireId } from "@top/protocol";
import { WebSocketServer, type WebSocket } from "ws";
import type { BotDirectory } from "./bots.ts";

const HIGH_WATER = 1 << 20; // 1 MiB queued on the socket: stop taking watch calls until it drains
const HEARTBEAT_MS = 15_000;

const serverId = randomUUID();

function send(socket: WebSocket, frame: ServerFrame) {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
}

function drained(socket: WebSocket): Promise<void> {
  if (socket.bufferedAmount < HIGH_WATER || socket.readyState !== socket.OPEN) return Promise.resolve();
  return new Promise((resolve) => {
    const check = () => {
      if (socket.bufferedAmount < HIGH_WATER || socket.readyState !== socket.OPEN) resolve();
      else setTimeout(check, 16);
    };
    check();
  });
}

function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

class ClientConnection {
  readonly #socket: WebSocket;
  readonly #harness: Harness;
  readonly #context: Context;
  readonly #cancel: () => void;
  readonly #watches = new Map<number, ConversationWatch>();
  readonly #unsubscribeBots: () => void;
  alive = true;

  constructor(socket: WebSocket, harness: Harness, directory: BotDirectory) {
    this.#socket = socket;
    this.#harness = harness;
    const { context, cancel } = withCancel(BACKGROUND_CONTEXT);
    this.#context = context;
    this.#cancel = cancel;
    socket.on("message", (data) => void this.#receive(String(data)));
    socket.on("pong", () => (this.alive = true));
    socket.on("close", () => this.close());
    send(socket, { t: "welcome", serverId, protocol: PROTOCOL_VERSION });
    send(socket, { t: "bots", bots: directory.list });
    this.#unsubscribeBots = directory.subscribe((bots) => send(socket, { t: "bots", bots }));
  }

  async #receive(text: string) {
    let frame: ClientFrame;
    try {
      frame = JSON.parse(text) as ClientFrame;
    } catch {
      return;
    }
    switch (frame.t) {
      case "hello":
      case "ping":
        if (frame.t === "ping") send(this.#socket, { t: "pong", at: frame.at });
        return;
      case "watch":
        return this.#watch(frame.sub, frame.conversationId, frame.window);
      case "unwatch": {
        const watch = this.#watches.get(frame.sub);
        this.#watches.delete(frame.sub);
        await watch?.stop();
        return;
      }
      case "entries":
        return this.#request(frame.req, async () => {
          const conversation = await this.#conversation(frame.conversationId);
          return conversation.entries(frame.query as never, frame.limit, undefined, this.#context);
        });
      case "submit":
        return this.#request(frame.req, async () => {
          const conversation = await this.#conversation(frame.conversationId);
          const submission = await conversation.submit(
            {
              type: "input",
              content: frame.content,
              requestId: frame.requestId,
              whenBusy: frame.whenBusy,
              entry: {
                kind: MESSAGE_KIND,
                data: { requestId: frame.requestId, text: frame.content, clientId: frame.clientId } satisfies MessageData,
              },
            },
            this.#context,
          );
          return { submissionId: submission.id };
        });
      case "abort":
        return this.#request(frame.req, async () => {
          const conversation = await this.#conversation(frame.conversationId);
          await conversation.abort(this.#context);
          return null;
        });
    }
  }

  async #conversation(id: WireId) {
    const conversation = await this.#harness.conversation(id as never, this.#context);
    if (!conversation) throw new Error(`Unknown conversation ${id}`);
    return conversation;
  }

  async #request(req: number, run: () => Promise<unknown>) {
    try {
      send(this.#socket, { t: "result", req, ok: true, value: await run() });
    } catch (error) {
      send(this.#socket, { t: "result", req, ok: false, error: errorText(error) });
    }
  }

  async #watch(sub: number, conversationId: WireId, window: WatchWindow | undefined) {
    try {
      const conversation = await this.#conversation(conversationId);
      const watch = await conversation.watch(this.#context, window as never);
      this.#watches.set(sub, watch);
      const encode = encoder();
      send(this.#socket, { t: "view", sub, value: watch.value });
      watch.start(async (call) => {
        if (call.kind !== "value") return;
        send(this.#socket, { t: "ops", sub, ops: encode.encode(call.ops) });
        await drained(this.#socket);
      });
      void watch.closed.then((end) => {
        if (this.#watches.get(sub) !== watch) return;
        this.#watches.delete(sub);
        send(this.#socket, { t: "end", sub, reason: end.kind });
      });
    } catch (error) {
      send(this.#socket, { t: "end", sub, reason: errorText(error) });
    }
  }

  close() {
    this.#unsubscribeBots();
    this.#cancel();
    for (const watch of this.#watches.values()) void watch.stop();
    this.#watches.clear();
  }

  get socket() {
    return this.#socket;
  }
}

export function serve(harness: Harness, directory: BotDirectory, options: { host: string; port: number }) {
  const server = new WebSocketServer({ host: options.host, port: options.port, perMessageDeflate: false });
  const clients = new Set<ClientConnection>();
  server.on("connection", (socket) => {
    const client = new ClientConnection(socket, harness, directory);
    clients.add(client);
    socket.on("close", () => clients.delete(client));
  });
  // Drop clients that stopped answering pings (a phone that lost its network without a FIN).
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
  return {
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(heartbeat);
        for (const client of clients) client.socket.close(1001, "server shutting down");
        server.close(() => resolve());
      }),
  };
}
