/**
 * One WebSocket per client, compressed with permessage-deflate.
 *
 * Every client gets the bot summaries once, then one small frame per bot that changed. A client
 * watches the bots it shows: `watch` answers with only the entries it is missing, then each new
 * entry is pushed once. Reading and registering happen in the same tick (SQLite is synchronous), so
 * no entry can slip between the catch-up and the live updates.
 *
 * The same port serves the bots' files over plain HTTP (see serveFile), so one address, tunnel or
 * Tailscale name reaches both.
 *
 * With `--tailscale`, a second listener on 127.0.0.1 is the daemon on the tailnet: Tailscale Serve
 * forwards to it, and every request there must come from a person or device the user allowed (see
 * tailscale.ts). The local port keeps working as before.
 */
import { timingSafeEqual } from "node:crypto";
import { stat } from "node:fs/promises";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join } from "node:path";
import type { Duplex } from "node:stream";
import { type Entry, type Gap, PROTOCOL_VERSION, parseClientFrame, type QueuedMessage, type ServerFrame, type Viewer } from "@top/protocol";
import { type WebSocket, WebSocketServer } from "ws";
import type { Daemon } from "./daemon.ts";
import { type FilesFolder, fileViews } from "./files.ts";
import { sendFile } from "./sendFile.ts";
import type { StoredEntry } from "./store.ts";
import type { Tailnet } from "./tailscale.ts";
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

function filesFrame(folder: FilesFolder): ServerFrame {
  const { listing } = folder;
  return { t: "files", bot: folder.bot, folder: folder.folder, files: fileViews(listing), ...(listing.more ? { more: true as const } : {}) };
}

function inboxOf(daemon: Daemon, bot: number): QueuedMessage[] {
  return daemon.store.inbox(bot).map((row) => ({
    requestId: row.requestId,
    text: row.text,
    mode: row.mode,
    at: row.at,
    ...(row.source ? { source: row.source } : {}),
    ...(row.attachments.length ? { attachments: row.attachments } : {}),
  }));
}

class ClientConnection {
  readonly socket: WebSocket;
  readonly #daemon: Daemon;
  readonly #watching = new Set<number>();
  readonly #unsubscribe: (() => void)[];
  /** The client's entries are from another daemon's data, so its `after` positions mean nothing here. */
  #foreign = false;
  alive = true;

  constructor(socket: WebSocket, daemon: Daemon, where: { tailnetUrl?: string | undefined; viewer?: Viewer | undefined }) {
    this.socket = socket;
    this.#daemon = daemon;
    socket.on("message", (data) => this.#receive(String(data)));
    socket.on("pong", () => (this.alive = true));
    socket.on("close", () => this.close());
    send(socket, {
      t: "welcome",
      serverId: daemon.store.id,
      protocol: PROTOCOL_VERSION,
      ...(daemon.hasFiles ? { filesPath: `${FILES_PREFIX}${daemon.store.filesSecret}` } : {}),
      ...(daemon.attachments ? { attachmentsPath: `${ATTACHMENTS_PREFIX}${daemon.store.filesSecret}` } : {}),
      ...(where.tailnetUrl ? { tailnetUrl: where.tailnetUrl } : {}),
      ...(where.viewer ? { viewer: where.viewer } : {}),
    });
    send(socket, { t: "bots", bots: daemon.bots });
    const mcp = daemon.mcp;
    if (mcp) send(socket, { t: "mcpServers", servers: mcp.views() });
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
      ...(mcp ? [mcp.onChange((server) => send(socket, { t: "mcpServer", server })), mcp.onRemoved((id) => send(socket, { t: "mcpServerRemoved", id }))] : []),
      daemon.onFiles((bot, folder) => {
        if (this.#watching.has(bot)) send(socket, filesFrame(folder));
      }),
      daemon.onInbox((bot) => {
        if (this.#watching.has(bot)) send(socket, { t: "inbox", bot, items: inboxOf(daemon, bot) });
      }),
    ];
  }

  #receive(text: string) {
    const parsed = parseClientFrame(text);
    if (!parsed.ok) {
      // Answer a request, so the client isn't left waiting for its timeout; drop anything else.
      if (parsed.req !== undefined) send(this.socket, { t: "result", req: parsed.req, ok: false, error: parsed.error });
      else console.warn(`[top] ignored a frame from a client: ${parsed.error}`);
      return;
    }
    const frame = parsed.frame;
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
        let entries: StoredEntry[];
        let gap: Gap | undefined;
        let earlier = false;
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
        send(this.socket, {
          t: "sync",
          bot: frame.bot,
          entries: wire(entries),
          ...(gap ? { gap } : {}),
          ...(earlier ? { earlier: true } : {}),
          inbox: inboxOf(this.#daemon, frame.bot),
        });
        const folder = this.#daemon.files(frame.bot);
        if (folder) send(this.socket, filesFrame(folder));
        return;
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
        return this.#answer(frame.req, () =>
          this.#daemon.submit(frame.bot, frame.requestId, frame.text, frame.whenBusy, frame.clientId, frame.attachments ?? []),
        );
      case "abort":
        return this.#answer(frame.req, () => {
          this.#daemon.stop(frame.bot);
          return null;
        });
      case "createBot":
        return this.#answer(frame.req, () => ({ id: this.#daemon.createBot(frame.name, frame.description) }));
      case "deleteBot":
        return this.#answer(frame.req, () => {
          this.#daemon.deleteBot(frame.bot);
          return null;
        });
      case "saveMcpServer":
        return this.#answer(frame.req, () => ({ id: this.#mcp().save(frame.id, frame.name, frame.config) }));
      case "deleteMcpServer":
        return this.#answer(frame.req, () => {
          this.#mcp().delete(frame.id);
          return null;
        });
      case "assignMcp":
        return this.#answer(frame.req, () => {
          if (!this.#daemon.runners.has(frame.bot)) throw new Error(`Unknown bot ${frame.bot}`);
          this.#mcp().assign(frame.server, frame.bot, frame.on);
          return null;
        });
      case "mcpSignIn":
        return this.#answer(frame.req, async () => ({ url: await this.#mcp().signIn(frame.id) }));
      case "mcpSignOut":
        return this.#answer(frame.req, () => {
          this.#mcp().signOut(frame.id);
          return null;
        });
      case "mcpRetry":
        return this.#answer(frame.req, () => {
          this.#mcp().retry(frame.id);
          return null;
        });
    }
  }

  #mcp() {
    const mcp = this.#daemon.mcp;
    if (!mcp) throw new Error("This daemon has no MCP servers.");
    return mcp;
  }

  /** A synchronous answer goes out in the same tick, before anything the request set off. */
  #answer(req: number, run: () => unknown) {
    const fail = (error: unknown) =>
      send(this.socket, {
        t: "result",
        req,
        ok: false,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      });
    try {
      const value = run();
      if (value instanceof Promise) value.then((v) => send(this.socket, { t: "result", req, ok: true, value: v }), fail);
      else send(this.socket, { t: "result", req, ok: true, value });
    } catch (error) {
      fail(error);
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

/**
 * Serve a bot's file. The secret in the path is what protects them: browsers let any web page make
 * requests to localhost, and a page that rebinds its own DNS name to 127.0.0.1 can even read the
 * answers, but neither can guess the secret. So any origin may read a file it has the link to (the
 * app fetches Markdown and text from `file://`), and pages never pass the link on as a referrer.
 *
 * A bot's HTML page runs with this address as its origin, which the WebSocket refuses (it isn't one
 * of the app's), so a page can't reach the daemon's controls.
 */
async function serveFile(daemon: Daemon, request: IncomingMessage, response: ServerResponse) {
  const fail = (status: number, message: string) => {
    response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    response.end(request.method === "HEAD" ? undefined : message);
  };
  const url = new URL(request.url ?? "/", "http://top");
  if (!url.pathname.startsWith(FILES_PREFIX) || !daemon.hasFiles) return fail(404, "Not found");
  const [secret = "", botId = "", ...rest] = url.pathname.slice(FILES_PREFIX.length).split("/");
  if (!sameSecret(secret, daemon.store.filesSecret)) return fail(404, "Not found");
  const folder = /^\d+$/.test(botId) ? daemon.files(Number(botId)) : undefined;
  if (!folder) return fail(404, "No such bot");
  response.setHeader("Access-Control-Allow-Origin", "*");
  if (request.method === "OPTIONS") {
    response.writeHead(204, { "Access-Control-Allow-Methods": "GET, HEAD", "Access-Control-Allow-Headers": "Range", "Access-Control-Max-Age": "86400" });
    return response.end();
  }
  if (request.method !== "GET" && request.method !== "HEAD") return fail(405, "Only GET and HEAD");
  let parts: string[];
  try {
    parts = rest.map(decodeURIComponent);
  } catch {
    return fail(400, "Bad path");
  }
  if (parts.at(-1) === "") parts.pop();
  // Only inside the folder, and not its hidden files (they aren't listed either).
  if (parts.some((part) => !part || part.startsWith(".") || /[/\\:\0]/.test(part))) return fail(404, "Not found");
  let path = join(folder.folder, ...parts);
  let info = await stat(path).catch(() => undefined);
  if (info?.isDirectory()) {
    // A folder with an index.html is a site: relative links between its pages work.
    if (!url.pathname.endsWith("/")) {
      response.writeHead(301, { Location: `${url.pathname}/${url.search}` });
      return response.end();
    }
    path = join(path, "index.html");
    info = await stat(path).catch(() => undefined);
  }
  if (!info?.isFile()) return fail(404, "Not found");
  sendFile(request, response, path, info, {
    "Content-Type": typeOf(path),
    // The file may change at any moment: always check, but a 304 costs nothing.
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
}

const isAttachment = (request: IncomingMessage) => (request.url ?? "").startsWith(ATTACHMENTS_PREFIX);

/** Uploads and attachments: `<attachmentsPath>/upload` and `<attachmentsPath>/<id>`, behind the files secret (see serveFile). */
async function serveAttachment(daemon: Daemon, request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url ?? "/", "http://top");
  const [secret = "", rest = "", ...more] = url.pathname.slice(ATTACHMENTS_PREFIX.length).split("/");
  if (!daemon.attachments || !sameSecret(secret, daemon.store.filesSecret) || more.length) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    return response.end("Not found");
  }
  return daemon.attachments.handle(request, response, rest, url.searchParams);
}

export type ServeOptions = {
  host: string;
  port: number;
  compress: boolean;
  allowOrigins?: readonly string[];
  /** Also serve on the tailnet: a listener on 127.0.0.1 that Tailscale Serve forwards to. */
  tailnet?: {
    readonly gate: Pick<Tailnet, "admit" | "url" | "self">;
    /** Its port on 127.0.0.1 (`0` picks a free one). */
    readonly port: number;
    /** MCP sign-in redirects arriving on the tailnet are passed to this port (see mcp.ts). */
    readonly oauthPort?: number;
    /** Their path. */
    readonly oauthPath?: string;
  };
};

/** Answers `/.well-known/top` on the tailnet, so the desktop app can find daemons there. */
const WELL_KNOWN = "/.well-known/top";

export function serve(daemon: Daemon, options: ServeOptions) {
  const allowed = new Set<string>([...APP_ORIGINS, ...(options.allowOrigins ?? [])]);
  const tailnet = options.tailnet;
  const server = new WebSocketServer({
    noServer: true,
    // Context takeover on both sides: repeated keys and names across frames cost almost nothing.
    perMessageDeflate: options.compress ? { threshold: 64, zlibDeflateOptions: { level: 6 } } : false,
  });
  const clients = new Set<ClientConnection>();
  const connect = (socket: WebSocket, viewer?: Viewer) => {
    const client = new ClientConnection(socket, daemon, { tailnetUrl: tailnet?.gate.url, viewer });
    clients.add(client);
    socket.on("close", () => clients.delete(client));
  };
  const originOk = (request: IncomingMessage) => {
    const origin = request.headers.origin;
    if (origin === undefined || allowed.has(origin)) return true;
    console.warn(`[top] refused a connection from ${origin} (pass --allow-origin ${origin} to allow it)`);
    return false;
  };
  const refuseUpgrade = (socket: Duplex, status: number, reason: string) => {
    const body = `${reason}\n`;
    socket.end(
      `HTTP/1.1 ${status} ${status === 403 ? "Forbidden" : "Bad Request"}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
    );
  };
  const handleFile = (request: IncomingMessage, response: ServerResponse) =>
    (isAttachment(request) ? serveAttachment(daemon, request, response) : serveFile(daemon, request, response)).catch((error) => {
      console.error("[top] serving a file:", error);
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });

  // ── this computer ──
  const http = createServer(handleFile);
  http.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!originOk(request)) return refuseUpgrade(socket, 403, "This origin may not connect.");
    server.handleUpgrade(request, socket, head, (ws) => connect(ws));
  });
  http.listen(options.port, options.host);

  // ── the tailnet, through Tailscale Serve ──
  let tailnetHttp: Server | undefined;
  if (tailnet) {
    const gate = tailnet.gate;
    tailnetHttp = createServer((request, response) => {
      void gate.admit(request).then(
        (admission) => {
          const path = new URL(request.url ?? "/", "http://top").pathname;
          if (path === WELL_KNOWN) {
            response.writeHead(admission.ok ? 200 : 403, { "Content-Type": "application/json", "Cache-Control": "no-store" });
            return response.end(
              JSON.stringify(
                admission.ok
                  ? { top: true, protocol: PROTOCOL_VERSION, serverId: daemon.store.id, device: gate.self.device, url: gate.url, viewer: admission.viewer }
                  : { top: true, device: gate.self.device, error: admission.reason },
              ),
            );
          }
          if (!admission.ok) {
            response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
            return response.end(`${admission.reason}\n`);
          }
          if (tailnet.oauthPort !== undefined && path === tailnet.oauthPath) return passOAuth(request, response, tailnet.oauthPort);
          return handleFile(request, response);
        },
        (error: unknown) => {
          console.error("[top] checking a tailnet caller:", error);
          if (!response.headersSent) response.writeHead(500);
          response.end();
        },
      );
    });
    tailnetHttp.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      if (!originOk(request)) return refuseUpgrade(socket, 403, "This origin may not connect.");
      gate.admit(request).then(
        (admission) => {
          if (!admission.ok) return refuseUpgrade(socket, 403, admission.reason);
          server.handleUpgrade(request, socket, head, (ws) => connect(ws, admission.viewer));
        },
        () => socket.destroy(),
      );
    });
    tailnetHttp.listen(tailnet.port, "127.0.0.1");
  }

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
  const listening = (server: Server) =>
    new Promise<number>((resolve, reject) => {
      server.once("listening", () => resolve((server.address() as { port: number }).port));
      server.once("error", reject);
    });
  const closeHttp = (server: Server | undefined) =>
    new Promise<void>((resolve) => {
      if (!server?.listening) return resolve();
      server.close(() => resolve());
      server.closeAllConnections();
    });
  return {
    /** Resolves with the port once listening (`port: 0` picks a free one). */
    listening: listening(http),
    /** Resolves with the tailnet listener's port on 127.0.0.1, when there is one. */
    tailnetListening: tailnetHttp ? listening(tailnetHttp) : undefined,
    close: async () => {
      clearInterval(heartbeat);
      for (const client of clients) client.socket.close(1001, "server shutting down");
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await Promise.all([closeHttp(http), closeHttp(tailnetHttp)]);
    },
  };
}

/**
 * An MCP sign-in redirect that came over the tailnet: hand it to the callback server on this computer,
 * which is open only while someone signs in.
 */
function passOAuth(request: IncomingMessage, response: ServerResponse, port: number) {
  const upstream = httpRequest(
    { host: "127.0.0.1", port, path: request.url, method: request.method, headers: { ...request.headers, host: `127.0.0.1:${port}` } },
    (reply) => {
      response.writeHead(reply.statusCode ?? 502, reply.headers);
      reply.pipe(response);
    },
  );
  upstream.on("error", () => {
    if (response.headersSent) return response.destroy();
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("No sign-in is waiting. Start it again from Top's settings.\n");
  });
  request.pipe(upstream);
}
