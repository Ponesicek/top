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
  SkillError,
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
  readonly WebSocket?: typeof WebSocket | undefined;
  readonly pingIntervalMs?: number | undefined;
  readonly deadAfterMs?: number | undefined;
  readonly requestTimeoutMs?: number | undefined;
  readonly connectTimeoutMs?: number | undefined;
};

type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;
export type RequestFrame = DistributiveOmit<Extract<ClientFrame, { readonly req: number }>, "req">;

const RETRY_DELAYS_MS = [0, 250, 250, 250, 500, 500, 1_000, 2_000, 3_000, 5_000];
const KICK_ANSWER_MS = 3_000;

export class OfflineError extends Schema.TaggedError<OfflineError>()("OfflineError", { message: Schema.String }) {}

export class TimeoutError extends Schema.TaggedError<TimeoutError>()("TimeoutError", { message: Schema.String }) {}

export class RequestError extends Schema.TaggedError<RequestError>()("RequestError", { message: Schema.String }) {}

export type RequestFailure =
  | OfflineError
  | TimeoutError
  | RequestError
  | BotError
  | BusyError
  | AttachmentError
  | McpServerError
  | PermissionError
  | SkillError;

const REFUSALS: Record<string, (message: string) => RequestFailure> = {
  BotError: (message) => new BotError({ message }),
  BusyError: (message) => new BusyError({ message }),
  AttachmentError: (message) => new AttachmentError({ message }),
  McpServerError: (message) => new McpServerError({ message }),
  PermissionError: (message) => new PermissionError({ message }),
  SkillError: (message) => new SkillError({ message }),
};

const numbered = (frame: RequestFrame, req: number): ClientFrame => ({ ...frame, req });

const decodeResult = <T extends RequestType>(t: T) => Schema.decodeUnknownEffect<(typeof RequestResult)[T]>(RequestResult[t]);

const refusal = (text: string): RequestFailure => {
  const match = /^(\w+): ([\s\S]*)$/.exec(text);
  const make = match ? REFUSALS[match[1]!] : undefined;
  return make ? make(match![2]!) : new RequestError({ message: text });
};

export type ConnectionHandlers = {
  readonly onFrame: (frame: ServerFrame) => void;
  readonly onOpen: () => void;
  readonly onStatus: () => void;
};

export type Connection = {
  readonly status: () => ConnectionStatus;
  readonly rttMs: () => number | undefined;
  readonly attempt: () => number;
  serverId: string | undefined;
  readonly send: (frame: ClientFrame) => boolean;
  readonly request: <F extends RequestFrame>(frame: F) => Effect.Effect<ResultOf<F["t"]>, RequestFailure>;
  readonly kick: Effect.Effect<void>;
};

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
        } catch {}
        for (const pending of requests.values()) Deferred.doneUnsafe(pending, Effect.fail(new OfflineError({ message: "Connection lost" })));
        requests.clear();
      }),
    );
    ws.onopen = () => Deferred.doneUnsafe(opened, Effect.succeed(true));
    ws.onmessage = (event) => {
      lastHeard = Date.now();
      receive(String(event.data));
    };
    ws.onclose = end;
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

  const keepConnected = Effect.gen(function* () {
    for (;;) {
      yield* Effect.scoped(session);
      setStatus("reconnecting");
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
      attempt = 0;
      return Effect.asVoid(FiberHandle.run(life, keepConnected));
    }),
  };
  yield* FiberHandle.run(life, keepConnected);
  return connection;
});
