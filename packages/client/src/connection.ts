/**
 * One WebSocket to the Top daemon that is never "just dead": it reconnects with backoff, notices a
 * silent connection (a phone that lost its network without a close) through pings, and resolves or
 * rejects every request.
 *
 * Pings are sparse (every 10 s) to keep a phone's radio asleep; when the app comes back to the
 * foreground or the network changes, `kick` checks the socket right away instead.
 *
 * It runs as fibers in the scope it's made in: one per socket's life, then a backoff, then the next.
 * Requests are Effects that end with the daemon's answer (or its refusal, as the protocol's errors),
 * `OfflineError` when there's no connection, or `TimeoutError`.
 */
import {
  AttachmentError,
  BotError,
  BusyError,
  type ClientFrame,
  McpServerError,
  PermissionError,
  PROTOCOL_VERSION,
  parseServerFrame,
  RequestResult,
  type RequestType,
  type ResultOf,
  type ServerFrame,
} from "@top/protocol";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberHandle from "effect/FiberHandle";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";

export type ConnectionStatus = "connecting" | "open" | "reconnecting";

export type ConnectionOptions = {
  readonly url: string;
  readonly clientId: string;
  /** The WebSocket constructor; the global one by default (browsers, Electron, React Native, Node ≥ 22). */
  readonly WebSocket?: typeof WebSocket | undefined;
  readonly pingIntervalMs?: number | undefined;
  /** No pong for this long means the connection is dead even if the socket says it is open. */
  readonly deadAfterMs?: number | undefined;
  readonly requestTimeoutMs?: number | undefined;
  /** A handshake that hasn't opened by then is abandoned and retried. */
  readonly connectTimeoutMs?: number | undefined;
};

type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;
/** A request as the caller writes it: the connection numbers it. */
export type RequestFrame = DistributiveOmit<Extract<ClientFrame, { readonly req: number }>, "req">;

const RETRY_DELAYS_MS = [0, 250, 250, 250, 500, 500, 1_000, 2_000, 3_000, 5_000];
/** After `kick`, an open socket that doesn't answer a ping this soon counts as dropped. */
const KICK_ANSWER_MS = 3_000;

/** There's no connection to the daemon right now (a request is never sent, or its connection dropped). */
export class OfflineError extends Schema.TaggedError<OfflineError>()("OfflineError", { message: Schema.String }) {}

/** The daemon didn't answer in time; it may or may not have done what was asked. */
export class TimeoutError extends Schema.TaggedError<TimeoutError>()("TimeoutError", { message: Schema.String }) {}

/** The daemon refused a request for a reason without a type of its own (an unknown bot, a malformed frame). */
export class RequestError extends Schema.TaggedError<RequestError>()("RequestError", { message: Schema.String }) {}

/** What a request can end in, besides its answer. */
export type RequestFailure = OfflineError | TimeoutError | RequestError | BotError | BusyError | AttachmentError | McpServerError | PermissionError;

const REFUSALS: Record<string, (message: string) => RequestFailure> = {
  BotError: (message) => new BotError({ message }),
  BusyError: (message) => new BusyError({ message }),
  AttachmentError: (message) => new AttachmentError({ message }),
  McpServerError: (message) => new McpServerError({ message }),
  PermissionError: (message) => new PermissionError({ message }),
};

const numbered = (frame: RequestFrame, req: number): ClientFrame => ({ ...frame, req });

/** Checks the answer to a request of type `t`. */
const decodeResult = <T extends RequestType>(t: T) => Schema.decodeUnknownEffect<(typeof RequestResult)[T]>(RequestResult[t]);

/** The daemon's `"<Tag>: <message>"` as the protocol's error, when it's one of those. */
const refusal = (text: string): RequestFailure => {
  const match = /^(\w+): ([\s\S]*)$/.exec(text);
  const make = match ? REFUSALS[match[1]!] : undefined;
  return make ? make(match![2]!) : new RequestError({ message: text });
};

export type ConnectionHandlers = {
  /** A frame that isn't an answer to a request. */
  readonly onFrame: (frame: ServerFrame) => void;
  /** A socket opened (the first time, or again after a drop). */
  readonly onOpen: () => void;
  readonly onStatus: () => void;
};

export type Connection = {
  readonly status: () => ConnectionStatus;
  readonly rttMs: () => number | undefined;
  readonly attempt: () => number;
  /** The daemon the client's entries came from; sent in `hello` (see the protocol). */
  serverId: string | undefined;
  /** Send a frame now; false when there's no open socket (nothing is queued). */
  readonly send: (frame: ClientFrame) => boolean;
  /** Send a request; its answer, checked against what that request answers with (see the protocol's `RequestResult`). */
  readonly request: <F extends RequestFrame>(frame: F) => Effect.Effect<ResultOf<F["t"]>, RequestFailure>;
  /**
   * The app returned to the foreground or the network changed. If connected, check that the socket
   * still answers; otherwise retry now instead of waiting out the backoff.
   */
  readonly kick: Effect.Effect<void>;
};

/** Connect, and keep connecting, for as long as the scope lasts. */
export const makeConnection = Effect.fnUntraced(function* (options: ConnectionOptions, handlers: ConnectionHandlers) {
  const WebSocketImpl = options.WebSocket ?? globalThis.WebSocket;
  if (!WebSocketImpl) return yield* Effect.die(new Error("No WebSocket implementation available"));
  const pingIntervalMs = options.pingIntervalMs ?? 10_000;
  const connectTimeoutMs = options.connectTimeoutMs ?? 5_000;
  const deadAfterMs = options.deadAfterMs ?? 25_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
  const scope = yield* Effect.scope;
  const life = yield* FiberHandle.make();

  let socket: WebSocket | undefined;
  let status: ConnectionStatus = "connecting";
  let attempt = 0;
  let lastHeard = 0;
  let rttMs: number | undefined;
  let nextReq = 1;
  const requests = new Map<number, Deferred.Deferred<unknown, RequestFailure>>();
  /** Ends the current socket's life: it closed, broke, or went silent. */
  let drop: (() => void) | undefined;

  const setStatus = (next: ConnectionStatus) => {
    if (status === next) return;
    status = next;
    handlers.onStatus();
  };

  const send = (frame: ClientFrame) => {
    if (status !== "open" || !socket) return false;
    socket.send(JSON.stringify(frame));
    return true;
  };

  const receive = (text: string) => {
    const parsed = parseServerFrame(text);
    if (!parsed.ok) {
      // A request it answered badly fails now rather than at its timeout.
      const pending = parsed.req === undefined ? undefined : requests.get(parsed.req);
      if (pending) {
        requests.delete(parsed.req!);
        Deferred.doneUnsafe(pending, Effect.fail(new RequestError({ message: parsed.error })));
      } else console.warn(`[top] ignored a frame from the daemon: ${parsed.error}`);
      return;
    }
    const frame = parsed.frame;
    if (frame.t === "pong") {
      rttMs = Date.now() - frame.at;
      return;
    }
    if (frame.t === "result") {
      const pending = requests.get(frame.req);
      if (!pending) return;
      requests.delete(frame.req);
      Deferred.doneUnsafe(pending, frame.ok ? Effect.succeed(frame.value) : Effect.fail(refusal(frame.error)));
      return;
    }
    handlers.onFrame(frame);
  };

  /** One socket, from opening to its end; its finalizer closes it and fails what it left unanswered. */
  const session = Effect.gen(function* () {
    const ws = new WebSocketImpl(options.url);
    socket = ws;
    const ended = yield* Deferred.make<void>();
    const opened = yield* Deferred.make<boolean>();
    const end = () => {
      Deferred.doneUnsafe(opened, Effect.succeed(false));
      Deferred.doneUnsafe(ended, Effect.void);
    };
    drop = end;
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (drop === end) drop = undefined;
        if (socket === ws) socket = undefined;
        ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
        try {
          ws.close();
        } catch {
          // already closed
        }
        for (const pending of requests.values()) Deferred.doneUnsafe(pending, Effect.fail(new OfflineError({ message: "Connection lost" })));
        requests.clear();
      }),
    );
    ws.onopen = () => Deferred.doneUnsafe(opened, Effect.succeed(true));
    ws.onmessage = (event) => {
      lastHeard = Date.now(); // any traffic proves the connection is alive
      receive(String(event.data));
    };
    ws.onclose = end;
    // Not every WebSocket follows an error with a close (Node 22's leaves a refused connection
    // CONNECTING forever), so an error counts as a lost connection on its own.
    ws.onerror = end;

    const open = yield* Deferred.await(opened).pipe(Effect.timeoutOption(Duration.millis(connectTimeoutMs)), Effect.map(Option.getOrElse(() => false)));
    if (!open) return;
    attempt = 0;
    lastHeard = yield* Clock.currentTimeMillis;
    ws.send(
      JSON.stringify({
        t: "hello",
        clientId: options.clientId,
        protocol: PROTOCOL_VERSION,
        ...(connection.serverId ? { serverId: connection.serverId } : {}),
      } satisfies ClientFrame),
    );
    setStatus("open");
    handlers.onOpen();
    const ping = Effect.gen(function* () {
      for (;;) {
        yield* Effect.sleep(Duration.millis(pingIntervalMs));
        const now = yield* Clock.currentTimeMillis;
        if (now - lastHeard > deadAfterMs) return;
        send({ t: "ping", at: now });
      }
    });
    yield* Effect.raceFirst(Deferred.await(ended), ping);
  });

  /** Connect, and after each drop wait a little and connect again. */
  const keepConnected = Effect.gen(function* () {
    for (;;) {
      yield* Effect.scoped(session);
      setStatus("reconnecting");
      // Retry fast through a blip (a daemon restart, a Wi-Fi handoff), then back off to 5 s. ±25% jitter
      // so a fleet of clients doesn't reconnect in lockstep.
      const base = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]!;
      attempt++;
      yield* Effect.sleep(Duration.millis(base * (0.75 + (yield* Random.next) * 0.5)));
    }
  });

  const connection: Connection = {
    status: () => status,
    rttMs: () => rttMs,
    attempt: () => attempt,
    serverId: undefined,
    send,
    request: <F extends RequestFrame>(frame: F): Effect.Effect<ResultOf<F["t"]>, RequestFailure> =>
      Effect.suspend(() => {
        if (status !== "open") return Effect.fail(new OfflineError({ message: "Not connected" }));
        const req = nextReq++;
        const answer = Deferred.makeUnsafe<unknown, RequestFailure>();
        requests.set(req, answer);
        send(numbered(frame, req));
        const decode = decodeResult(frame.t);
        return Deferred.await(answer).pipe(
          Effect.timeoutOrElse({
            duration: Duration.millis(requestTimeoutMs),
            orElse: () => Effect.fail(new TimeoutError({ message: "Request timed out" })),
          }),
          Effect.flatMap((value) =>
            Effect.mapError(decode(value), (error) => new RequestError({ message: `The daemon's answer to ${frame.t} wasn't readable: ${error.message}` })),
          ),
          Effect.ensuring(Effect.sync(() => requests.delete(req))),
        );
      }),
    kick: Effect.flatMap(Clock.currentTimeMillis, (sentAt) => {
      if (status === "open") {
        const current = drop;
        send({ t: "ping", at: sentAt });
        return Effect.asVoid(
          Effect.forkIn(
            Effect.sleep(Duration.millis(KICK_ANSWER_MS)).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  if (drop === current && status === "open" && lastHeard < sentAt) current?.();
                }),
              ),
            ),
            scope,
          ),
        );
      }
      // Down: connect now instead of waiting out the backoff.
      attempt = 0;
      return Effect.asVoid(FiberHandle.run(life, keepConnected));
    }),
  };
  yield* FiberHandle.run(life, keepConnected);
  return connection;
});
