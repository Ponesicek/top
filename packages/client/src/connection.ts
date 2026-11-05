/**
 * One WebSocket to the Top daemon that is never "just dead": it reconnects with backoff, notices a
 * silent connection (a phone that lost its network without a close) within a few seconds through
 * pings, and resolves or rejects every request.
 */
import { PROTOCOL_VERSION, type ClientFrame, type ServerFrame } from "@top/protocol";

export type ConnectionStatus = "connecting" | "open" | "reconnecting";

export type ConnectionOptions = {
  readonly url: string;
  readonly clientId: string;
  /** The WebSocket constructor; the global one by default (browsers, Electron, React Native, Node ≥ 22). */
  readonly WebSocket?: typeof WebSocket;
  readonly pingIntervalMs?: number;
  /** No pong for this long means the connection is dead even if the socket says it is open. */
  readonly deadAfterMs?: number;
  readonly requestTimeoutMs?: number;
};

type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;
export type RequestFrame = DistributiveOmit<Extract<ClientFrame, { req: number }>, "req">;

const RETRY_DELAYS_MS = [0, 250, 250, 250, 500, 500, 1_000, 2_000, 3_000, 5_000];

type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };

export class OfflineError extends Error {
  override name = "OfflineError";
}

export class TimeoutError extends Error {
  override name = "TimeoutError";
}

export class Connection {
  readonly #options: Required<Omit<ConnectionOptions, "WebSocket">> & { WebSocket: typeof WebSocket };
  #socket: WebSocket | undefined;
  #status: ConnectionStatus = "connecting";
  #attempt = 0;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #pingTimer: ReturnType<typeof setInterval> | undefined;
  #lastPong = 0;
  #rttMs: number | undefined;
  #nextReq = 1;
  readonly #requests = new Map<number, Pending>();
  #closed = false;

  onFrame: (frame: ServerFrame) => void = () => {};
  onOpen: () => void = () => {};
  onStatus: () => void = () => {};

  constructor(options: ConnectionOptions) {
    const WebSocketImpl = options.WebSocket ?? globalThis.WebSocket;
    if (!WebSocketImpl) throw new Error("No WebSocket implementation available");
    this.#options = {
      pingIntervalMs: 3_000,
      deadAfterMs: 8_000,
      requestTimeoutMs: 15_000,
      ...options,
      WebSocket: WebSocketImpl,
    };
  }

  get status(): ConnectionStatus {
    return this.#status;
  }
  get rttMs(): number | undefined {
    return this.#rttMs;
  }
  get attempt(): number {
    return this.#attempt;
  }

  start() {
    this.#connect();
  }

  /** Retry now instead of waiting out the backoff, for example when the OS reports the network is back. */
  kick() {
    if (this.#status === "open" || this.#closed) return;
    clearTimeout(this.#retryTimer);
    this.#attempt = 0;
    this.#connect();
  }

  send(frame: ClientFrame): boolean {
    const socket = this.#socket;
    if (this.#status !== "open" || !socket) return false;
    socket.send(JSON.stringify(frame));
    return true;
  }

  request<T = unknown>(frame: RequestFrame): Promise<T> {
    const req = this.#nextReq++;
    return new Promise<T>((resolve, reject) => {
      if (this.#status !== "open") return reject(new OfflineError("Not connected"));
      const timer = setTimeout(() => {
        this.#requests.delete(req);
        reject(new TimeoutError("Request timed out"));
      }, this.#options.requestTimeoutMs);
      this.#requests.set(req, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.send({ ...frame, req } as ClientFrame);
    });
  }

  close() {
    this.#closed = true;
    clearTimeout(this.#retryTimer);
    this.#teardown();
  }

  #setStatus(status: ConnectionStatus) {
    if (this.#status === status) return;
    this.#status = status;
    this.onStatus();
  }

  #connect() {
    if (this.#closed) return;
    this.#teardown();
    const socket = new this.#options.WebSocket(this.#options.url);
    this.#socket = socket;
    socket.onopen = () => {
      if (this.#socket !== socket) return;
      this.#attempt = 0;
      this.#lastPong = Date.now();
      socket.send(JSON.stringify({ t: "hello", clientId: this.#options.clientId, protocol: PROTOCOL_VERSION } satisfies ClientFrame));
      this.#pingTimer = setInterval(() => this.#ping(), this.#options.pingIntervalMs);
      this.#setStatus("open");
      this.onOpen();
    };
    socket.onmessage = (event) => {
      if (this.#socket !== socket) return;
      this.#lastPong = Date.now(); // any traffic proves the connection is alive
      const frame = JSON.parse(String(event.data)) as ServerFrame;
      if (frame.t === "pong") {
        this.#rttMs = Date.now() - frame.at;
        return;
      }
      if (frame.t === "result") {
        const pending = this.#requests.get(frame.req);
        if (!pending) return;
        this.#requests.delete(frame.req);
        clearTimeout(pending.timer);
        if (frame.ok) pending.resolve(frame.value);
        else pending.reject(new Error(frame.error));
        return;
      }
      this.onFrame(frame);
    };
    socket.onclose = () => {
      if (this.#socket === socket) this.#lost();
    };
    socket.onerror = () => {
      // onclose follows; nothing to do here.
    };
  }

  #ping() {
    if (Date.now() - this.#lastPong > this.#options.deadAfterMs) {
      this.#lost();
      return;
    }
    this.send({ t: "ping", at: Date.now() });
  }

  #lost() {
    this.#teardown();
    if (this.#closed) return;
    this.#setStatus("reconnecting");
    // Retry fast through a blip (a daemon restart, a Wi-Fi handoff), then back off to 5 s. ±25% jitter
    // so a fleet of clients doesn't reconnect in lockstep.
    const base = RETRY_DELAYS_MS[Math.min(this.#attempt, RETRY_DELAYS_MS.length - 1)]!;
    const delay = base * (0.75 + Math.random() * 0.5);
    this.#attempt++;
    this.#retryTimer = setTimeout(() => this.#connect(), delay);
  }

  #teardown() {
    clearInterval(this.#pingTimer);
    const socket = this.#socket;
    this.#socket = undefined;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      try {
        socket.close();
      } catch {
        // already closed
      }
    }
    for (const pending of this.#requests.values()) {
      clearTimeout(pending.timer);
      pending.reject(new OfflineError("Connection lost"));
    }
    this.#requests.clear();
  }
}
