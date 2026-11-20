import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import {
  type ClientFrame,
  type Entry,
  type Gap,
  PROTOCOL_VERSION,
  parseClientFrame,
  type QueuedMessage,
  type RequestType,
  type ResultOf,
  type ServerFrame,
  TaskError,
  UnknownBotError,
  UnknownEntryError,
  type Viewer,
} from "@top/protocol";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HttpBody from "effect/http/HttpBody";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpMethod from "effect/http/HttpMethod";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import type * as Socket from "effect/socket/Socket";
import { Attachments } from "./attachments.ts";
import { BUILD } from "./build.ts";
import { ChatGPT } from "./chatgpt.ts";
import { Daemon } from "./daemon.ts";
import { type DaemonEvent, Events } from "./events.ts";
import { fileViews, type Listing } from "./files.ts";
import { Mcp } from "./mcp.ts";
import { type FileServing, sendFile, sendFramedPage } from "./sendFile.ts";
import { Store, type StoredEntry } from "./store.ts";
import type { Tailnet } from "./tailscale.ts";
import { Updates } from "./updates.ts";
import { toWire } from "./wire.ts";

const DEFAULT_WINDOW = 50;
const MAX_WINDOW = 200;
const SILENT_MS = 60_000;
const MAX_BACKLOG = 20_000;

const wire = (entries: readonly StoredEntry[]): Entry[] => entries.flatMap((e) => toWire(e) ?? []);

const filesFrame = (bot: number, folder: string, listing: Listing): ServerFrame => ({
  t: "files",
  bot,
  folder,
  files: fileViews(listing),
  ...(listing.more ? { more: true as const } : {}),
});

const inboxOf = (store: Store["Service"], bot: number) =>
  Effect.map(store.inbox(bot), (rows) =>
    rows.map(
      (row): QueuedMessage => ({
        requestId: row.requestId,
        text: row.text,
        mode: row.mode,
        at: row.at,
        ...(row.source ? { source: row.source } : {}),
        ...(row.attachments.length ? { attachments: row.attachments } : {}),
      }),
    ),
  );

const errorText = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
};

type Write = (frame: ServerFrame) => Effect.Effect<void>;

const connection = Effect.fnUntraced(function* (socket: Socket.Socket, where: { tailnetUrl?: string | undefined; viewer?: Viewer | undefined }) {
  const scope = yield* Effect.scope;
  const daemon = yield* Daemon;
  const store = yield* Store;
  const events = yield* Events;
  const mcp = Option.getOrUndefined(yield* Effect.serviceOption(Mcp));
  const chatgpt = Option.getOrUndefined(yield* Effect.serviceOption(ChatGPT));
  const updates = Option.getOrUndefined(yield* Effect.serviceOption(Updates));
  const attachments = Option.getOrUndefined(yield* Effect.serviceOption(Attachments));
  const reader = yield* socket.reader;
  const writer = yield* socket.writer;
  const send: Write = (frame) => Effect.ignore(writer.write(JSON.stringify(frame)));
  const turn = yield* Semaphore.make(1);
  const watching = new Map<number, number>();
  let foreign = false;
  let lastHeard = yield* Clock.currentTimeMillis;
  const closed = yield* Latch.make(false);

  const { subscription, before } = yield* events.subscribe;
  let handled = 0;
  const waiting = new Set<{ readonly until: number; readonly done: Deferred.Deferred<void> }>();
  const caughtUp = Effect.gen(function* () {
    const until = (yield* events.published) - before;
    if (handled >= until) return;
    const done = yield* Deferred.make<void>();
    const waiter = { until, done };
    waiting.add(waiter);
    yield* Deferred.await(done).pipe(Effect.ensuring(Effect.sync(() => waiting.delete(waiter))));
  });
  yield* send({
    t: "welcome",
    serverId: store.id,
    protocol: PROTOCOL_VERSION,
    version: BUILD.version,
    ...(BUILD.channel ? { channel: updates ? (yield* updates.view).channel : BUILD.channel } : {}),
    ...(daemon.hasFiles ? { filesPath: `${FILES_PREFIX}${store.filesSecret}` } : {}),
    ...(attachments ? { attachmentsPath: `${ATTACHMENTS_PREFIX}${store.filesSecret}` } : {}),
    ...(where.tailnetUrl ? { tailnetUrl: where.tailnetUrl } : {}),
    ...(where.viewer ? { viewer: where.viewer } : {}),
  });
  yield* send({ t: "bots", bots: daemon.bots() });
  if (mcp) yield* send({ t: "mcpServers", servers: yield* mcp.views });
  if (daemon.skills) yield* send({ t: "skills", skills: daemon.skills.view() });
  if (chatgpt) yield* send({ t: "account", account: yield* chatgpt.view });
  if (updates) yield* send({ t: "update", update: yield* updates.view });
  yield* send({ t: "asks", asks: yield* daemon.asks.waiting });
  // Every change sends what's waiting now, not the event's own list: an event from before the first send is replayed
  // after it, and would put back a question that was answered meanwhile.
  let sentWaiting = "";
  const sendWaiting = daemon.tasks
    ? Effect.flatMap(daemon.tasks.waiting, (now) => {
        const json = JSON.stringify(now);
        if (json === sentWaiting) return Effect.void;
        sentWaiting = json;
        return send({ t: "waitingTasks", tasks: [...now] });
      })
    : Effect.void;
  yield* sendWaiting;

  const onEvent = (event: DaemonEvent): Effect.Effect<void> => {
    switch (event._tag) {
      case "Entry": {
        const sent = watching.get(event.entry.bot);
        if (sent === undefined || event.entry.seq <= sent) return Effect.void;
        watching.set(event.entry.bot, event.entry.seq);
        const entry = toWire(event.entry);
        return entry ? send({ t: "entry", entry }) : Effect.void;
      }
      case "Inbox":
        return watching.has(event.bot) ? Effect.flatMap(inboxOf(store, event.bot), (items) => send({ t: "inbox", bot: event.bot, items })) : Effect.void;
      case "Bot":
        return send({ t: "bot", bot: event.summary });
      case "BotRemoved":
        watching.delete(event.bot);
        return send({ t: "botRemoved", bot: event.bot });
      case "Files":
        return watching.has(event.bot) ? send(filesFrame(event.bot, event.folder, event.listing)) : Effect.void;
      case "McpServer":
        return send({ t: "mcpServer", server: event.view });
      case "McpServerRemoved":
        return send({ t: "mcpServerRemoved", id: event.id });
      case "Skills":
        return send({ t: "skills", skills: event.view });
      case "Account":
        return send({ t: "account", account: event.view });
      case "Update":
        return send({ t: "update", update: event.view });
      case "Asks":
        return Effect.flatMap(daemon.asks.waiting, (asks) => send({ t: "asks", asks }));
      case "WaitingTasks":
        return sendWaiting;
    }
  };
  yield* Effect.forkScoped(
    Effect.forever(
      Effect.gen(function* () {
        const event = yield* PubSub.take(subscription);
        yield* turn.withPermits(1)(onEvent(event));
        handled++;
        for (const waiter of waiting) if (handled >= waiter.until) Deferred.doneUnsafe(waiter.done, Effect.void);
        if ((yield* PubSub.remaining(subscription)) > MAX_BACKLOG) yield* closed.open;
      }),
    ),
  );

  const answer = <T extends RequestType, E>({ req }: { readonly t: T; readonly req: number }, run: Effect.Effect<Answer<T>, E>) =>
    Effect.flatMap(Effect.exit(Effect.withSpan(run, `Connection.${requestName(req)}`)), (exit) =>
      Effect.andThen(
        caughtUp,
        send(Exit.isSuccess(exit) ? { t: "result", req, ok: true, value: exit.value ?? null } : { t: "result", req, ok: false, error: errorText(exit.cause) }),
      ),
    ).pipe(Effect.ensuring(Effect.sync(() => kinds.delete(req))));
  const mcpOf = () => (mcp ? Effect.succeed(mcp) : Effect.fail(new NoMcp()));
  const chatgptOf = () => (chatgpt ? Effect.succeed(chatgpt) : Effect.fail(new NoChatGPT()));
  const updatesOf = () => (updates ? Effect.succeed(updates) : Effect.fail(new NoUpdates()));
  const skillsOf = () => (daemon.skills ? Effect.succeed(daemon.skills) : Effect.fail(new NoSkills()));
  const tasksOf = () => (daemon.tasks ? Effect.succeed(daemon.tasks) : Effect.fail(new TaskError({ message: "This daemon runs no harnesses." })));
  const known = (bot: number) => (daemon.has(bot) ? Effect.void : Effect.fail(new UnknownBotError({ bot })));
  const botRow = (id: number) =>
    Effect.gen(function* () {
      yield* known(id);
      const bot = yield* store.bot(id);
      if (!bot) return yield* new UnknownBotError({ bot: id });
      return bot;
    });

  const watch = (frame: Extract<ClientFrame, { t: "watch" }>) =>
    Effect.gen(function* () {
      if (!daemon.has(frame.bot)) return;
      const limit = Math.min(Math.max(1, frame.limit ?? DEFAULT_WINDOW), MAX_WINDOW);
      let entries: StoredEntry[];
      let gap: Gap | undefined;
      let earlier = false;
      const after = foreign ? undefined : frame.after;
      if (after === undefined) {
        entries = yield* store.newest(frame.bot, limit);
        earlier = entries.length > 0 && (yield* store.hasBefore(frame.bot, entries[0]!.seq));
      } else {
        entries = yield* store.after(frame.bot, after, limit + 1);
        if (entries.length > limit) {
          entries = yield* store.newest(frame.bot, limit);
          gap = { after, before: entries[0]!.seq };
        }
      }
      watching.set(frame.bot, entries.at(-1)?.seq ?? after ?? 0);
      yield* send({
        t: "sync",
        bot: frame.bot,
        entries: wire(entries),
        ...(gap ? { gap } : {}),
        ...(earlier ? { earlier: true } : {}),
        inbox: yield* inboxOf(store, frame.bot),
      });
      const folder = daemon.files(frame.bot);
      if (folder) yield* send(filesFrame(frame.bot, folder.folder, folder.listing()));
    });

  const kinds = new Map<number, string>();
  const requestName = (req: number) => kinds.get(req) ?? "request";
  const receive = (text: string): Effect.Effect<void> => {
    const parsed = parseClientFrame(text);
    if (parsed.ok && "req" in parsed.frame) kinds.set(parsed.frame.req, parsed.frame.t);
    if (!parsed.ok) {
      if (parsed.req !== undefined) return send({ t: "result", req: parsed.req, ok: false, error: parsed.error });
      return Effect.logWarning(`ignored a frame from a client: ${parsed.error}`);
    }
    const frame = parsed.frame;
    switch (frame.t) {
      case "hello":
        foreign = frame.serverId !== undefined && frame.serverId !== store.id;
        return Effect.void;
      case "ping":
        return send({ t: "pong", at: frame.at });
      case "watch":
        return turn.withPermits(1)(watch(frame));
      case "unwatch":
        watching.delete(frame.bot);
        return Effect.void;
      case "history":
        return answer(
          frame,
          Effect.map(store.history(frame.bot, frame.before, frame.after ?? 0, Math.min(Math.max(1, frame.limit), MAX_WINDOW)), ({ entries, more }) => ({
            entries: wire(entries),
            more,
          })),
        );
      case "detail":
        return answer(
          frame,
          Effect.flatMap(store.entry(frame.seq), (stored) =>
            !stored || stored.bot !== frame.bot ? Effect.fail(new UnknownEntryError({ seq: frame.seq })) : Effect.succeed(toWire(stored, true) ?? null),
          ),
        );
      case "submit":
        return answer(frame, daemon.submit(frame.bot, frame.requestId, frame.text, frame.whenBusy, frame.clientId, frame.attachments ?? []));
      case "abort":
        return answer(frame, daemon.stop(frame.bot));
      case "createBot":
        return answer(
          frame,
          Effect.map(daemon.createBot(frame.name, frame.description, frame.avatar), (id) => ({ id })),
        );
      case "deleteBot":
        return answer(frame, daemon.deleteBot(frame.bot));
      case "contextFiles":
        return answer(frame, daemon.contextFiles(frame.bot));
      case "saveContextFile":
        return answer(frame, daemon.saveContextFile(frame.bot, frame.name, frame.content, frame.version));
      case "saveMcpServer":
        return answer(
          frame,
          Effect.flatMap(mcpOf(), (m) => Effect.map(m.save(frame.id, frame.name, frame.config), (id) => ({ id }))),
        );
      case "deleteMcpServer":
        return answer(
          frame,
          Effect.flatMap(mcpOf(), (m) => m.delete(frame.id)),
        );
      case "assignMcp":
        return answer(
          frame,
          Effect.flatMap(mcpOf(), (m) => Effect.andThen(known(frame.bot), m.assign(frame.server, frame.bot, frame.on))),
        );
      case "mcpSignIn":
        return Effect.asVoid(
          Effect.forkIn(
            Effect.flatMap(Effect.exit(Effect.flatMap(mcpOf(), (m) => Effect.map(m.signIn(frame.id), (url) => ({ url })))), (exit) => answer(frame, exit)),
            scope,
          ),
        );
      case "mcpSignOut":
        return answer(
          frame,
          Effect.flatMap(mcpOf(), (m) => m.signOut(frame.id)),
        );
      case "mcpRetry":
        return answer(
          frame,
          Effect.flatMap(mcpOf(), (m) => m.retry(frame.id)),
        );
      case "enableSkills":
        return answer(
          frame,
          Effect.gen(function* () {
            const skills = yield* skillsOf();
            yield* skills.enable(yield* botRow(frame.bot), frame.names, frame.on);
          }),
        );
      case "previewSkillFolder":
        return answer(
          frame,
          Effect.flatMap(skillsOf(), (s) => s.preview(frame.folder)),
        );
      case "addSkillFolder":
        return answer(
          frame,
          Effect.gen(function* () {
            const skills = yield* skillsOf();
            const bots = yield* Effect.forEach([...new Set(frame.bots)], botRow);
            return yield* skills.addFolder(frame.folder, bots);
          }),
        );
      case "setWebSearch":
        return answer(frame, daemon.setWebSearch(frame.bot, frame.on));
      case "rescanSkills":
        return answer(
          frame,
          Effect.flatMap(skillsOf(), (s) => s.rescan),
        );
      case "chatgptSignIn":
        return answer(
          frame,
          Effect.flatMap(chatgptOf(), (c) => Effect.map(c.signIn, (url) => ({ url }))),
        );
      case "chatgptSignInFinish":
        return Effect.asVoid(
          Effect.forkIn(
            answer(
              frame,
              Effect.flatMap(chatgptOf(), (c) => c.finish(frame.url)),
            ),
            scope,
          ),
        );
      case "chatgptSignInCancel":
        return answer(
          frame,
          Effect.flatMap(chatgptOf(), (c) => c.cancel),
        );
      case "chatgptSignOut":
        return answer(
          frame,
          Effect.flatMap(chatgptOf(), (c) => c.signOut),
        );
      case "checkForUpdate":
        return answer(
          frame,
          Effect.flatMap(updatesOf(), (u) => u.check),
        );
      case "installUpdate":
        return answer(
          frame,
          Effect.flatMap(updatesOf(), (u) => Effect.asVoid(Effect.forkDetach(u.install(frame.version).pipe(Effect.ignoreCause({ log: true }))))),
        );
      case "setUpdateChannel":
        return answer(
          frame,
          Effect.flatMap(updatesOf(), (u) => u.setChannel(frame.channel)),
        );
      case "answer":
        return answer(frame, daemon.asks.answer(frame.id, frame.bot, frame.reply));
      case "saveSecret":
        return answer(frame, daemon.asks.saveSecret(frame.id, frame.bot, frame.value));
      case "answerTask":
        return answer(
          frame,
          Effect.flatMap(tasksOf(), (t) => Effect.asVoid(t.respond("user", undefined, frame.task, frame.input, { answers: frame.answers }))),
        );
    }
  };

  const reading = Effect.forever(
    Effect.gen(function* () {
      const frames = yield* reader.pull;
      lastHeard = yield* Clock.currentTimeMillis;
      for (const data of frames) yield* receive(typeof data === "string" ? data : Buffer.from(data).toString("utf8"));
    }),
  ).pipe(Effect.ignore);
  const silence = Effect.repeat(
    Effect.gen(function* () {
      if ((yield* Clock.currentTimeMillis) - lastHeard > SILENT_MS) yield* closed.open;
    }),
    Schedule.spaced(Duration.millis(SILENT_MS / 4)),
  );
  yield* Effect.raceFirst(reading, Effect.raceFirst(closed.await, silence));
});

// biome-ignore lint/suspicious/noConfusingVoidType: handlers that only do something are `Effect<void>`; `answer` sends `null` for them
type Answer<T extends RequestType> = ResultOf<T> extends null ? void : ResultOf<T>;

class NoMcp extends Data.TaggedError("NoMcp") {
  override get message() {
    return "This daemon has no MCP servers.";
  }
}

class NoSkills extends Data.TaggedError("NoSkills") {
  override get message() {
    return "This daemon has no skills.";
  }
}

class NoUpdates extends Data.TaggedError("NoUpdates") {
  override get message() {
    return BUILD.channel
      ? "This server wasn't installed with `top install`, so it can't update itself."
      : "This server runs from a checkout of Top's code. Update it with git pull.";
  }
}

class NoChatGPT extends Data.TaggedError("NoChatGPT") {
  override get message() {
    return "This daemon's bots don't sign in (they're fake).";
  }
}

export const APP_ORIGINS = ["file://", "http://localhost:5199", "http://127.0.0.1:5199"] as const;

const FILES_PREFIX = "/files/";
const ATTACHMENTS_PREFIX = "/attachments/";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".markdown": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".tsv": "text/tab-separated-values; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".yaml": "text/yaml; charset=utf-8",
  ".yml": "text/yaml; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
};
const PLAIN = new Set(
  "mmd ts tsx jsx py rb go rs java kt swift c h cpp hpp cs php sh bash zsh ps1 sql toml ini cfg conf env diff patch lua r jl scala dart vue svelte"
    .split(" ")
    .map((ext) => `.${ext}`),
);

const typeOf = (path: string) => {
  const ext = extname(path).toLowerCase();
  return TYPES[ext] ?? (PLAIN.has(ext) ? "text/plain; charset=utf-8" : "application/octet-stream");
};

function sameSecret(given: string, secret: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

function decodeParts(parts: readonly string[]): string[] | undefined {
  try {
    return parts.map(decodeURIComponent);
  } catch {
    return undefined;
  }
}

const plainText = (request: HttpServerRequest.HttpServerRequest, status: number, message: string, headers: Record<string, string> = {}) =>
  HttpServerResponse.text(request.method === "HEAD" ? "" : message, {
    status,
    contentType: "text/plain; charset=utf-8",
    headers: { "cache-control": "no-store", ...headers },
  });

const serveFile = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function* () {
    const daemon = yield* Daemon;
    const store = yield* Store;
    const url = new URL(request.url, "http://top");
    if (!url.pathname.startsWith(FILES_PREFIX) || !daemon.hasFiles) return plainText(request, 404, "Not found");
    const [secret = "", botId = "", ...rest] = url.pathname.slice(FILES_PREFIX.length).split("/");
    if (!sameSecret(secret, store.filesSecret)) return plainText(request, 404, "Not found");
    const folder = /^\d+$/.test(botId) ? daemon.files(Number(botId)) : undefined;
    if (!folder) return plainText(request, 404, "No such bot");
    const cors = { "access-control-allow-origin": "*" };
    if (request.method === "OPTIONS")
      return HttpServerResponse.empty({
        status: 204,
        headers: { ...cors, "access-control-allow-methods": "GET, HEAD", "access-control-allow-headers": "Range", "access-control-max-age": "86400" },
      });
    if (request.method !== "GET" && request.method !== "HEAD") return plainText(request, 405, "Only GET and HEAD", cors);
    const parts = decodeParts(rest);
    if (!parts) return plainText(request, 400, "Bad path", cors);
    if (parts.at(-1) === "") parts.pop();
    if (parts.some((part) => !part || part.startsWith(".") || /[/\\:\0]/.test(part))) return plainText(request, 404, "Not found", cors);
    const path = join(folder.folder, ...parts);
    const headers = (file: string) => ({
      "Content-Type": typeOf(file),
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Access-Control-Allow-Origin": "*",
    });
    const framed = url.searchParams.has("frame");
    const send = (file: string) =>
      framed && typeOf(file).startsWith("text/html") ? sendFramedPage(request, file, headers(file)) : sendFile(request, file, headers(file));
    return yield* send(path).pipe(
      Effect.catchTag("NotFound", () =>
        Effect.gen(function* () {
          const index = join(path, "index.html");
          const response = yield* Effect.option(send(index));
          if (Option.isNone(response)) return plainText(request, 404, "Not found", cors);
          if (!url.pathname.endsWith("/")) return HttpServerResponse.redirect(`${url.pathname}/${url.search}`, { status: 301, headers: cors });
          return response.value;
        }),
      ),
    );
  });

const serveAttachment = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const attachments = Option.getOrUndefined(yield* Effect.serviceOption(Attachments));
    const url = new URL(request.url, "http://top");
    const [secret = "", rest = "", ...more] = url.pathname.slice(ATTACHMENTS_PREFIX.length).split("/");
    if (!attachments || !sameSecret(secret, store.filesSecret) || more.length) return plainText(request, 404, "Not found");
    return yield* attachments.handle(request, rest);
  });

const serveHttp = (request: HttpServerRequest.HttpServerRequest) =>
  request.url.startsWith(ATTACHMENTS_PREFIX) ? serveAttachment(request) : serveFile(request);

const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "te", "trailer", "upgrade", "host", "content-length"]);
const passable = (headers: Readonly<Record<string, string | undefined>>) =>
  Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== undefined && !HOP_BY_HOP.has(entry[0])));

const passOAuth = (request: HttpServerRequest.HttpServerRequest, port: number) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const method = request.method;
    if (!HttpMethod.isHttpMethod(method)) return HttpServerResponse.empty({ status: 405 });
    const bodied = method !== "GET" && method !== "HEAD";
    const reply = yield* client.execute(
      HttpClientRequest.make(method)(`http://127.0.0.1:${port}${request.url}`, {
        headers: passable(request.headers),
        ...(bodied ? { body: HttpBody.stream(request.stream, request.headers["content-type"]) } : {}),
      }),
    );
    const contentType = reply.headers["content-type"];
    return HttpServerResponse.stream(reply.stream, {
      status: reply.status,
      headers: passable(reply.headers),
      ...(contentType ? { contentType } : {}),
    });
  }).pipe(Effect.catch(() => Effect.succeed(plainText(request, 404, "No sign-in is waiting. Start it again from Top's settings.\n"))));

const WELL_KNOWN = "/.well-known/top";

export type ServeOptions = {
  readonly host: string;
  readonly port: number;
  readonly compress: boolean;
  readonly allowOrigins?: readonly string[] | undefined;
  readonly tailnet?:
    | {
        readonly gate: Pick<Tailnet, "admit" | "url" | "self">;
        readonly port: number;
        readonly oauthPort?: number | undefined;
        readonly oauthPath?: string | undefined;
      }
    | undefined;
};

export class ListenError extends Data.TaggedError("ListenError")<{ readonly host: string; readonly port: number; readonly cause: unknown }> {
  override get message() {
    const cause = this.cause;
    const nested = typeof cause === "object" && cause !== null && "cause" in cause ? cause.cause : undefined;
    const inner = nested instanceof Error ? nested.message : cause instanceof Error ? cause.message : String(cause);
    return `can't listen on ${this.host}:${this.port}: ${inner}`;
  }
}

type Served = Daemon | Store | Events | FileServing;

const listen = (
  host: string,
  port: number,
  compress: boolean,
  app: Effect.Effect<HttpServerResponse.HttpServerResponse, never, HttpServerRequest.HttpServerRequest | Served>,
) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      NodeHttpServer.layer(() => createServer(), {
        host,
        port,
        websocket: { perMessageDeflate: compress ? { threshold: 64, zlibDeflateOptions: { level: 6 } } : false },
      }),
    ).pipe(Effect.mapError((cause) => new ListenError({ host, port, cause })));
    const server = Context.get(context, HttpServer.HttpServer);
    yield* server.serve(app).pipe(Effect.provideContext(context));
    const address = server.address;
    return address._tag === "UnixPathAddress" ? port : address.port;
  });

export const serve = (options: ServeOptions) =>
  Effect.gen(function* () {
    const services = yield* Effect.context<Daemon | Store | Events>();
    const allowed = new Set<string>([...APP_ORIGINS, ...(options.allowOrigins ?? [])]);
    const tailnet = options.tailnet;

    const originOk = (request: HttpServerRequest.HttpServerRequest) =>
      Effect.gen(function* () {
        const origin = request.headers.origin;
        if (origin === undefined || allowed.has(origin)) return true;
        yield* Effect.logWarning(`refused a connection from ${origin} (pass --allow-origin ${origin} to allow it)`);
        return false;
      });
    const upgrade = (request: HttpServerRequest.HttpServerRequest, viewer?: Viewer) =>
      Effect.gen(function* () {
        if (!(yield* originOk(request))) return plainText(request, 403, "This origin may not connect.\n");
        const socket = yield* request.upgrade;
        yield* Effect.scoped(connection(socket, { tailnetUrl: tailnet?.gate.url, viewer }));
        return HttpServerResponse.empty();
      });
    const isUpgrade = (request: HttpServerRequest.HttpServerRequest) => request.headers.upgrade?.toLowerCase() === "websocket";
    const failed = (what: string) => (cause: Cause.Cause<unknown>) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.succeed(HttpServerResponse.empty({ status: 499 }))
        : Effect.as(Effect.logError(what, cause), HttpServerResponse.empty({ status: 500 }));

    const local = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (isUpgrade(request)) return yield* upgrade(request);
      return yield* serveHttp(request);
    }).pipe(Effect.catchCause(failed("serving a request")), Effect.provideContext(services));
    const port = yield* listen(options.host, options.port, options.compress, local);

    let tailnetPort: number | undefined;
    if (tailnet) {
      const gate = tailnet.gate;
      const httpClient = yield* Layer.build(NodeHttpClient.layerNodeHttp);
      const app = Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const admission = yield* gate.admit(request.headers);
        const path = new URL(request.url, "http://top").pathname;
        if (isUpgrade(request)) return admission.ok ? yield* upgrade(request, admission.viewer) : plainText(request, 403, `${admission.reason}\n`);
        if (path === WELL_KNOWN) {
          const store = yield* Store;
          return HttpServerResponse.jsonUnsafe(
            admission.ok
              ? { top: true, protocol: PROTOCOL_VERSION, serverId: store.id, device: gate.self.device, url: gate.url, viewer: admission.viewer }
              : { top: true, device: gate.self.device, error: admission.reason },
            { status: admission.ok ? 200 : 403, headers: { "cache-control": "no-store" } },
          );
        }
        if (!admission.ok) return plainText(request, 403, `${admission.reason}\n`);
        if (tailnet.oauthPort !== undefined && path === tailnet.oauthPath) return yield* passOAuth(request, tailnet.oauthPort);
        return yield* serveHttp(request);
      }).pipe(Effect.catchCause(failed("serving a tailnet request")), Effect.provideContext(Context.merge(services, httpClient)));
      tailnetPort = yield* listen("127.0.0.1", tailnet.port, options.compress, app);
    }
    return { port, tailnetPort };
  });
