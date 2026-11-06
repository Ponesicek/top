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
 */
import { timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join } from "node:path";
import { type Entry, type Gap, PROTOCOL_VERSION, parseClientFrame, type QueuedMessage, type ServerFrame } from "@top/protocol";
import { type WebSocket, WebSocketServer } from "ws";
import type { Daemon } from "./daemon.ts";
import { type FilesFolder, fileViews } from "./files.ts";
import type { StoredEntry } from "./store.ts";
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
  return daemon.store
    .inbox(bot)
    .map((row) => ({ requestId: row.requestId, text: row.text, mode: row.mode, at: row.at, ...(row.source ? { source: row.source } : {}) }));
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
    send(socket, {
      t: "welcome",
      serverId: daemon.store.id,
      protocol: PROTOCOL_VERSION,
      ...(daemon.hasFiles ? { filesPath: `${FILES_PREFIX}${daemon.store.filesSecret}` } : {}),
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
        return this.#answer(frame.req, () => this.#daemon.submit(frame.bot, frame.requestId, frame.text, frame.whenBusy, frame.clientId));
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
  const etag = `"${info.size.toString(36)}-${Math.round(info.mtimeMs).toString(36)}"`;
  const headers: Record<string, string> = {
    "Content-Type": typeOf(path),
    ETag: etag,
    // The file may change at any moment: always check, but a 304 costs nothing.
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Accept-Ranges": "bytes",
    "Access-Control-Expose-Headers": "ETag, Content-Length, Content-Range",
  };
  if (request.headers["if-none-match"] === etag) {
    response.writeHead(304, headers);
    return response.end();
  }
  // One byte range, for seeking in video and audio.
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(request.headers.range ?? ""));
  let start = 0;
  let end = info.size - 1;
  let status = 200;
  if (range && (range[1] || range[2])) {
    start = range[1] ? Number(range[1]) : Math.max(0, info.size - Number(range[2]));
    end = range[1] && range[2] ? Math.min(Number(range[2]), info.size - 1) : info.size - 1;
    if (start > end || start >= info.size) {
      response.writeHead(416, { ...headers, "Content-Range": `bytes */${info.size}` });
      return response.end();
    }
    status = 206;
    headers["Content-Range"] = `bytes ${start}-${end}/${info.size}`;
  }
  headers["Content-Length"] = String(info.size === 0 ? 0 : end - start + 1);
  response.writeHead(status, headers);
  if (request.method === "HEAD" || info.size === 0) return response.end();
  const stream = createReadStream(path, { start, end });
  stream.on("error", () => response.destroy());
  stream.pipe(response);
}

export function serve(daemon: Daemon, options: { host: string; port: number; compress: boolean; allowOrigins?: readonly string[] }) {
  const allowed = new Set<string>([...APP_ORIGINS, ...(options.allowOrigins ?? [])]);
  const http = createServer((request, response) => {
    serveFile(daemon, request, response).catch((error) => {
      console.error("[top] serving a file:", error);
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  http.listen(options.port, options.host);
  const server = new WebSocketServer({
    server: http,
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
    /** Resolves with the port once listening (`port: 0` picks a free one). */
    listening: new Promise<number>((resolve, reject) => {
      http.once("listening", () => resolve((http.address() as { port: number }).port));
      http.once("error", reject);
    }),
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(heartbeat);
        for (const client of clients) client.socket.close(1001, "server shutting down");
        server.close(() => http.close(() => resolve()));
        http.closeAllConnections();
      }),
  };
}
