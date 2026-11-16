/**
 * One WebSocket per client, compressed with permessage-deflate, on Effect's HTTP server.
 *
 * Every client gets the bot summaries once, then one small frame per bot that changed. A client
 * watches the bots it shows: `watch` answers with only the entries it is missing, then each new
 * entry is pushed once. A connection listens to the daemon's events from the moment it opens, and
 * remembers the newest entry each `watch` sent, so no entry slips between the catch-up and the live
 * updates and none comes twice.
 *
 * A request's answer goes out after the frames about what it did while it ran (a new bot's summary
 * before `createBot`'s answer), as each connection waits until it has sent every event published by
 * then. `watch` and the events take turns on a lock, so the catch-up and the live entries can't cross.
 *
 * The same port serves the bots' files over plain HTTP (see serveFile), so one address, tunnel or
 * Tailscale name reaches both.
 *
 * With `--tailscale`, a second listener on 127.0.0.1 is the daemon on the tailnet: Tailscale Serve
 * forwards to it, and every request there must come from a person or device the user allowed (see
 * tailscale.ts). The local port keeps working as before.
 */
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
import { type FileServing, sendFile } from "./sendFile.ts";
import { Store, type StoredEntry } from "./store.ts";
import type { Tailnet } from "./tailscale.ts";
import { Updates } from "./updates.ts";
import { toWire } from "./wire.ts";

const DEFAULT_WINDOW = 50;
const MAX_WINDOW = 200;
/** Clients ping every 10 s; one silent this long has lost its network without closing the socket. */
const SILENT_MS = 60_000;
/** A client this far behind is reading nothing; drop it and let it resync on reconnect. */
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

/** What a failed request tells the client: `<Tag>: <message>`, as the protocol's `result` frame carries it. */
const errorText = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
};

type Write = (frame: ServerFrame) => Effect.Effect<void>;

/** One client's WebSocket, from its first frame to its close. */
const connection = Effect.fnUntraced(function* (socket: Socket.Socket, where: { tailnetUrl?: string | undefined; viewer?: Viewer | undefined }) {
  const scope = yield* Effect.scope;
  const daemon = yield* Daemon;
  const store = yield* Store;
  const events = yield* Events;
  const mcp = Option.getOrUndefined(yield* Effect.serviceOption(Mcp));
  const chatgpt = Option.getOrUndefined(yield* Effect.serviceOption(ChatGPT));
  const updates = Option.getOrUndefined(yield* Effect.serviceOption(Updates));
  const attachments = Option.getOrUndefined(yield* Effect.serviceOption(Attachments));
  // Taking the reader completes the handshake; frames written before it would wait for it.
  const reader = yield* socket.reader;
  const writer = yield* socket.writer;
  const send: Write = (frame) => Effect.ignore(writer.write(JSON.stringify(frame)));
  /** `watch` and the events take turns, so the catch-up and the live entries can't cross. */
  const turn = yield* Semaphore.make(1);
  /** Each watched bot, with the newest entry it was sent. */
  const watching = new Map<number, number>();
  /** The client's entries are from another daemon's data, so its `after` positions mean nothing here. */
  let foreign = false;
  let lastHeard = yield* Clock.currentTimeMillis;
  const closed = yield* Latch.make(false);

  // Listen first, then send what is: an event in between is one the snapshot may already show, and
  // sending a summary or a listing twice changes nothing.
  const { subscription, before } = yield* events.subscribe;
  /** Events this connection has handled, and answers waiting for it to reach a count (see `caughtUp`). */
  let handled = 0;
  const waiting = new Set<{ readonly until: number; readonly done: Deferred.Deferred<void> }>();
  /** Wait until every event published so far has gone out to this client. */
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
  if (chatgpt) yield* send({ t: "account", account: yield* chatgpt.view });
  if (updates) yield* send({ t: "update", update: yield* updates.view });
  yield* send({ t: "permissions", requests: yield* daemon.permissions.waiting });

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
      case "Account":
        return send({ t: "account", account: event.view });
      case "Update":
        return send({ t: "update", update: event.view });
      case "Permissions":
        return send({ t: "permissions", requests: event.waiting });
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

  /** Run a request (in a span named for it, `Connection.submit`, …) and answer it with what that request answers (`null` for none). */
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
  const known = (bot: number) => (daemon.has(bot) ? Effect.void : Effect.fail(new UnknownBotError({ bot })));

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
          // Missed more than fit: send the newest, and say what lies between.
          entries = yield* store.newest(frame.bot, limit);
          gap = { after, before: entries[0]!.seq };
        }
      }
      // Live entries continue after the newest one sent, or after the client's own newest when it's current.
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

  /** The kind of each request being answered, for its span. */
  const kinds = new Map<number, string>();
  const requestName = (req: number) => kinds.get(req) ?? "request";
  const receive = (text: string): Effect.Effect<void> => {
    const parsed = parseClientFrame(text);
    if (parsed.ok && "req" in parsed.frame) kinds.set(parsed.frame.req, parsed.frame.t);
    if (!parsed.ok) {
      // Answer a request, so the client isn't left waiting for its timeout; drop anything else.
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
        // It waits on the MCP server: other frames go on meanwhile.
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
      case "chatgptSignIn":
        return answer(
          frame,
          Effect.flatMap(chatgptOf(), (c) => Effect.map(c.signIn, (url) => ({ url }))),
        );
      case "chatgptSignInFinish":
        // It waits on OpenAI: other frames go on meanwhile.
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
        // Not awaited by the connection: the daemon restarts at the end, and the answer goes out before.
        return answer(
          frame,
          Effect.flatMap(updatesOf(), (u) => Effect.asVoid(Effect.forkDetach(u.install(frame.version).pipe(Effect.ignoreCause({ log: true }))))),
        );
      case "setUpdateChannel":
        return answer(
          frame,
          Effect.flatMap(updatesOf(), (u) => u.setChannel(frame.channel)),
        );
      case "answerPermission":
        return answer(frame, daemon.permissions.answer(frame.id, frame.bot, frame.allow));
    }
  };

  const reading = Effect.forever(
    Effect.gen(function* () {
      const frames = yield* reader.pull;
      lastHeard = yield* Clock.currentTimeMillis;
      for (const data of frames) yield* receive(typeof data === "string" ? data : Buffer.from(data).toString("utf8"));
    }),
  ).pipe(Effect.ignore);
  // Drop clients that stopped talking (a phone that lost its network without closing the socket).
  const silence = Effect.repeat(
    Effect.gen(function* () {
      if ((yield* Clock.currentTimeMillis) - lastHeard > SILENT_MS) yield* closed.open;
    }),
    Schedule.spaced(Duration.millis(SILENT_MS / 4)),
  );
  yield* Effect.raceFirst(reading, Effect.raceFirst(closed.await, silence));
});

/** What a request's handler comes to: its result, or nothing for those that answer `null`. */
// biome-ignore lint/suspicious/noConfusingVoidType: handlers that only do something are `Effect<void>`; `answer` sends `null` for them
type Answer<T extends RequestType> = ResultOf<T> extends null ? void : ResultOf<T>;

/** The daemon has no MCP servers set up (a test daemon). */
class NoMcp extends Data.TaggedError("NoMcp") {
  override get message() {
    return "This daemon has no MCP servers.";
  }
}

/** The daemon runs from a checkout, or wasn't installed with `top install`: it doesn't update itself. */
class NoUpdates extends Data.TaggedError("NoUpdates") {
  override get message() {
    return BUILD.channel
      ? "This server wasn't installed with `top install`, so it can't update itself."
      : "This server runs from a checkout of Top's code. Update it with git pull.";
  }
}

/** The daemon runs fake bots, which need no sign-in. */
class NoChatGPT extends Data.TaggedError("NoChatGPT") {
  override get message() {
    return "This daemon's bots don't sign in (they're fake).";
  }
}

/**
 * Browsers let any web page open a WebSocket to localhost, and the bots can run commands, so a browser
 * connection is accepted only from the app itself: the Electron build (`file://`) and the dev/web UI
 * (`pnpm desktop`, `pnpm web` on :5199). Native clients (Node, the phone app) send no Origin.
 *
 * Not `null`: that's the Origin of a sandboxed frame, which any web page (or a bot's own page in the
 * Files panel) can make, so accepting it would let them run commands. The Electron build sends `file://`.
 */
export const APP_ORIGINS = ["file://", "http://localhost:5199", "http://127.0.0.1:5199"] as const;

// ── files over HTTP ──────────────────────────────────────────────────────────────

/** Files are at `/files/<secret>/<bot id>/<path>`. */
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
/** Source code and other text without a type of its own: shown as text, not downloaded. */
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

/** A file path's parts, decoded; undefined if one isn't valid percent-encoding. */
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

/**
 * Serve a bot's file. The secret in the path is what protects them: browsers let any web page make
 * requests to localhost, and a page that rebinds its own DNS name to 127.0.0.1 can even read the
 * answers, but neither can guess the secret. So any origin may read a file it has the link to (the
 * app fetches Markdown and text from `file://`), and pages never pass the link on as a referrer.
 *
 * A bot's HTML page runs with this address as its origin, which the WebSocket refuses (it isn't one
 * of the app's), so a page can't reach the daemon's controls.
 */
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
    // Only inside the folder, and not its hidden files (they aren't listed either).
    if (parts.some((part) => !part || part.startsWith(".") || /[/\\:\0]/.test(part))) return plainText(request, 404, "Not found", cors);
    const path = join(folder.folder, ...parts);
    const headers = (file: string) => ({
      "Content-Type": typeOf(file),
      // The file may change at any moment: always check, but a 304 costs nothing.
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Access-Control-Allow-Origin": "*",
    });
    return yield* sendFile(request, path, headers(path)).pipe(
      Effect.catchTag("NotFound", () =>
        Effect.gen(function* () {
          // A folder with an index.html is a site: relative links between its pages work.
          const index = join(path, "index.html");
          const response = yield* Effect.option(sendFile(request, index, headers(index)));
          if (Option.isNone(response)) return plainText(request, 404, "Not found", cors);
          if (!url.pathname.endsWith("/")) return HttpServerResponse.redirect(`${url.pathname}/${url.search}`, { status: 301, headers: cors });
          return response.value;
        }),
      ),
    );
  });

/** Uploads and attachments: `<attachmentsPath>/upload` and `<attachmentsPath>/<id>`, behind the files secret (see serveFile). */
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

/** Headers about one connection rather than the message (and Host, which names the hop): never passed along. */
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "te", "trailer", "upgrade", "host", "content-length"]);
const passable = (headers: Readonly<Record<string, string | undefined>>) =>
  Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== undefined && !HOP_BY_HOP.has(entry[0])));

/**
 * An MCP sign-in redirect that came over the tailnet: hand it to the callback server on this computer,
 * which is open only while someone signs in, and send back what it answers, as it answers it.
 */
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

/** Answers `/.well-known/top` on the tailnet, so the desktop app can find daemons there. */
const WELL_KNOWN = "/.well-known/top";

export type ServeOptions = {
  readonly host: string;
  readonly port: number;
  readonly compress: boolean;
  readonly allowOrigins?: readonly string[] | undefined;
  /** Also serve on the tailnet: a listener on 127.0.0.1 that Tailscale Serve forwards to. */
  readonly tailnet?:
    | {
        readonly gate: Pick<Tailnet, "admit" | "url" | "self">;
        /** Its port on 127.0.0.1 (`0` picks a free one). */
        readonly port: number;
        /** MCP sign-in redirects arriving on the tailnet are passed to this port (see mcp.ts). */
        readonly oauthPort?: number | undefined;
        /** Their path. */
        readonly oauthPath?: string | undefined;
      }
    | undefined;
};

/** A listener couldn't open its port. */
export class ListenError extends Data.TaggedError("ListenError")<{ readonly host: string; readonly port: number; readonly cause: unknown }> {
  override get message() {
    const cause = this.cause;
    const nested = typeof cause === "object" && cause !== null && "cause" in cause ? cause.cause : undefined;
    const inner = nested instanceof Error ? nested.message : cause instanceof Error ? cause.message : String(cause);
    return `can't listen on ${this.host}:${this.port}: ${inner}`;
  }
}

type Served = Daemon | Store | Events | FileServing;

/** Listen on one port with `app`; answers with the port (`0` picks a free one). */
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
        // Context takeover on both sides: repeated keys and names across frames cost almost nothing.
        websocket: { perMessageDeflate: compress ? { threshold: 64, zlibDeflateOptions: { level: 6 } } : false },
      }),
    ).pipe(Effect.mapError((cause) => new ListenError({ host, port, cause })));
    const server = Context.get(context, HttpServer.HttpServer);
    yield* server.serve(app).pipe(Effect.provideContext(context));
    const address = server.address;
    return address._tag === "UnixPathAddress" ? port : address.port;
  });

/** Serve the daemon until the scope closes; answers with the ports it listens on. */
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

    // ── this computer ──
    const local = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (isUpgrade(request)) return yield* upgrade(request);
      return yield* serveHttp(request);
    }).pipe(Effect.catchCause(failed("serving a request")), Effect.provideContext(services));
    const port = yield* listen(options.host, options.port, options.compress, local);

    // ── the tailnet, through Tailscale Serve ──
    let tailnetPort: number | undefined;
    if (tailnet) {
      const gate = tailnet.gate;
      // For passing sign-in redirects on (see passOAuth).
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
