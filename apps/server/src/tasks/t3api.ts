// T3 Code's own client API: HTTP for auth and reads, and its WebSocket RPC (Effect RPC, JSON) for
// orchestration. Top never uses T3 Code's /mcp endpoint or T3 Connect.
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname } from "node:path";

/** The orchestration protocol Top speaks; T3 Code refuses a socket for any other. */
export const T3_PROTOCOL = 2;
/** What Top asks for: read threads and projects, and start, message, answer and stop threads. */
export const T3_SCOPES = ["orchestration:read", "orchestration:operate"] as const;
const TIMEOUT_MS = 15_000;
const PING_MS = 20_000;

export type T3Config = {
  readonly url: string;
  readonly token: string;
  readonly environmentId: string;
  readonly label: string;
  readonly serverVersion: string;
  readonly connectedAt: string;
};

export type Descriptor = { readonly environmentId: string; readonly label: string; readonly serverVersion: string; readonly protocol: number | undefined };

/** T3 Code refused the credential: retrying won't help; pairing again will. */
export class T3AuthError extends Error {}
/** T3 Code answered the request and refused it. */
export class T3Refused extends Error {}
/** The request may or may not have reached T3 Code. */
export class T3Unreachable extends Error {}

const record = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {});
const str = (value: unknown) => (typeof value === "string" ? value : undefined);

/** The address the user gave, as an origin. Never guessed: it has to be an http(s) URL. */
export function t3Origin(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error(`"${input}" isn't an address; give T3 Code's full URL, like https://machine.tailnet.ts.net or http://127.0.0.1:3773.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`T3 Code's address has to start with https:// or http:// (got ${url.protocol}).`);
  if (url.username || url.password) throw new Error("Leave the sign-in out of the address; Top pairs with a code instead.");
  return url.origin;
}

/** Plain HTTP stays private only on this computer; anywhere else, even a tailnet, it takes `--plain-http`. */
export function plainHttpExposed(origin: string): boolean {
  const url = new URL(origin);
  if (url.protocol === "https:") return false;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost") return false;
  if (isIP(host) === 4) return !host.startsWith("127.");
  return !(isIP(host) === 6 && host === "::1");
}

export async function readT3Config(file: string): Promise<T3Config | undefined> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const raw = record(JSON.parse(text));
  const url = str(raw.url);
  const token = str(raw.token);
  if (!url || !token) throw new Error(`${file} is missing its address or credential; run \`top t3code connect\` again.`);
  return {
    url,
    token,
    environmentId: str(raw.environmentId) ?? "",
    label: str(raw.label) ?? url,
    serverVersion: str(raw.serverVersion) ?? "",
    connectedAt: str(raw.connectedAt) ?? "",
  };
}

export async function writeT3Config(file: string, config: T3Config): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, file);
}

export const removeT3Config = (file: string) => rm(file, { force: true });

async function http(origin: string, path: string, init: RequestInit = {}): Promise<Response> {
  let response: Response;
  try {
    // Never follow a redirect: it could hand a pairing code or the credential to another address.
    response = await fetch(`${origin}${path}`, { ...init, redirect: "manual", signal: init.signal ?? AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    const cause = record(record(error).cause);
    const why = str(cause.code) ?? str(cause.message) ?? (error instanceof Error ? error.message : String(error));
    throw new T3Unreachable(`Couldn't reach T3 Code at ${origin} (${why}).`);
  }
  if (response.status >= 300 && response.status < 400)
    throw new T3Refused(`${origin}${path} redirects elsewhere (HTTP ${response.status}); give T3 Code's own address, not one that forwards to it.`);
  return response;
}

async function json(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** The environment's public descriptor: no credential is sent before the address answers as T3 Code. */
export async function describe(origin: string): Promise<Descriptor> {
  const response = await http(origin, "/.well-known/t3/environment");
  const body = record(await json(response));
  const environmentId = str(body.environmentId);
  const serverVersion = str(body.serverVersion);
  if (!response.ok || !environmentId || !serverVersion)
    throw new T3Refused(`${origin} doesn't answer as a T3 Code server (HTTP ${response.status} at /.well-known/t3/environment).`);
  const protocol = typeof body.orchestrationProtocolVersion === "number" ? body.orchestrationProtocolVersion : undefined;
  return { environmentId, label: str(body.label) ?? origin, serverVersion, protocol };
}

export function checkProtocol(origin: string, descriptor: Descriptor): void {
  if (descriptor.protocol !== T3_PROTOCOL)
    throw new T3Refused(
      `T3 Code ${descriptor.serverVersion} at ${origin} speaks orchestration protocol ${descriptor.protocol ?? "1 or older"}; Top speaks ${T3_PROTOCOL}. ${
        (descriptor.protocol ?? 0) < T3_PROTOCOL ? "Update T3 Code there." : "Update Top."
      }`,
    );
}

/** Checks the credential and that it holds the scopes Top needs. */
export async function checkSession(origin: string, token: string): Promise<{ readonly expiresAt: string | undefined }> {
  const response = await http(origin, "/api/auth/session", { headers: bearer(token) });
  const body = record(await json(response));
  if (body.authenticated !== true)
    throw new T3AuthError(`T3 Code at ${origin} no longer accepts Top's credential (expired or revoked). Pair again with \`top t3code connect ${origin}\`.`);
  const granted = new Set([...(Array.isArray(body.permissions) ? body.permissions : []), ...(Array.isArray(body.scopes) ? body.scopes : [])].map(String));
  const missing = T3_SCOPES.filter((scope) => !granted.has(scope));
  if (missing.length)
    throw new T3AuthError(
      `Top's credential for T3 Code at ${origin} lacks ${missing.join(" and ")}. Pair again with a code that grants ${T3_SCOPES.join(" and ")}.`,
    );
  return { expiresAt: str(body.expiresAt) };
}

/** Trades a one-time pairing code for Top's own bearer session, narrowed to what Top needs. */
export async function exchangePairingCode(origin: string, code: string, label: string): Promise<string> {
  const form = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token: code.trim(),
    subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
    requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    scope: T3_SCOPES.join(" "),
    client_label: label,
    client_device_type: "bot",
  });
  const response = await http(origin, "/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form });
  const body = record(await json(response));
  const token = str(body.access_token);
  if (response.ok && token) return token;
  const reason = str(body.reason) ?? str(body.code) ?? `HTTP ${response.status}`;
  throw new T3AuthError(
    reason === "scope_not_granted"
      ? `That pairing code doesn't grant ${T3_SCOPES.join(" and ")}.`
      : `T3 Code at ${origin} didn't take that code (${reason}). Codes work once and expire; make a fresh one.`,
  );
}

export type T3Project = { readonly id: string; readonly title: string; readonly workspaceRoot: string };

export async function listProjects(origin: string, token: string): Promise<readonly T3Project[]> {
  const response = await http(origin, "/api/projects", { headers: bearer(token) });
  if (response.status === 401)
    throw new T3AuthError(`T3 Code at ${origin} no longer accepts Top's credential. Pair again with \`top t3code connect ${origin}\`.`);
  const body = record(await json(response));
  if (!response.ok || !Array.isArray(body.projects)) throw new T3Refused(`T3 Code at ${origin} didn't list its projects (HTTP ${response.status}).`);
  return body.projects
    .map(record)
    .filter((p) => p.archivedAt === null || p.archivedAt === undefined)
    .map((p) => ({ id: str(p.id) ?? "", title: str(p.title) ?? "", workspaceRoot: str(p.workspaceRoot) ?? "" }))
    .filter((p) => p.id && p.workspaceRoot);
}

/** A short-lived ticket for one socket, so the credential never goes into a socket URL. */
async function rpcTicket(origin: string, token: string): Promise<string> {
  const response = await http(origin, "/api/auth/websocket-ticket/rpc", { method: "POST", headers: bearer(token) });
  if (response.status === 401)
    throw new T3AuthError(`T3 Code at ${origin} no longer accepts Top's credential. Pair again with \`top t3code connect ${origin}\`.`);
  const ticket = str(record(await json(response)).ticket);
  if (!response.ok || !ticket) throw new T3Refused(`T3 Code at ${origin} didn't issue a socket ticket (HTTP ${response.status}).`);
  return ticket;
}

type Waiter = { readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void };
type Stream = { readonly item: (value: unknown) => void; readonly end: (error: Error) => void };

function failureText(exit: Record<string, unknown>): string {
  const causes = Array.isArray(exit.cause) ? exit.cause.map(record) : [];
  for (const cause of causes) {
    if (cause._tag === "Fail") {
      const error = record(cause.error);
      return str(error.message) ?? str(error.detail) ?? str(error._tag) ?? JSON.stringify(cause.error);
    }
    if (cause._tag === "Die") return `T3 Code failed: ${typeof cause.defect === "string" ? cause.defect : JSON.stringify(cause.defect)}`;
  }
  return "T3 Code refused it.";
}

/**
 * One RPC socket. Requests that were sent and not answered when it drops fail with T3Unreachable:
 * the caller can't know whether T3 Code took them, so it may only retry what is idempotent.
 */
export class RpcSocket {
  private readonly pending = new Map<string, Waiter>();
  private readonly streams = new Map<string, Stream>();
  private next = 1;
  private ping: NodeJS.Timeout | undefined;
  private closedWith: Error | undefined;
  private heard = Date.now();

  private readonly ws: WebSocket;
  private readonly onClose: (error: Error) => void;

  private constructor(ws: WebSocket, onClose: (error: Error) => void) {
    this.ws = ws;
    this.onClose = onClose;
    ws.addEventListener("message", (event) => this.receive(String(event.data)));
    ws.addEventListener("close", (event) =>
      this.shut(new T3Unreachable(`The connection to T3 Code closed (${event.code}${event.reason ? ` ${event.reason}` : ""}).`)),
    );
    ws.addEventListener("error", () => this.shut(new T3Unreachable("The connection to T3 Code failed.")));
    this.ping = setInterval(() => {
      // T3 Code answers each ping; a socket that has gone quiet that long is dead even if TCP hasn't noticed.
      if (Date.now() - this.heard > PING_MS * 2 + 5_000) {
        this.shut(new T3Unreachable("T3 Code stopped answering."));
        try {
          this.ws.close();
        } catch {}
        return;
      }
      this.send({ _tag: "Ping" });
    }, PING_MS);
    this.ping.unref();
  }

  static async open(origin: string, token: string, onClose: (error: Error) => void): Promise<RpcSocket> {
    const ticket = await rpcTicket(origin, token);
    const url = new URL("/ws", origin.replace(/^http/, "ws"));
    url.searchParams.set("orchestrationProtocol", String(T3_PROTOCOL));
    url.searchParams.set("wsTicket", ticket);
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.close();
        reject(new T3Unreachable(`T3 Code at ${origin} didn't open a socket in time.`));
      }, TIMEOUT_MS);
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new T3Unreachable(`T3 Code at ${origin} refused the socket.`));
      });
    });
    return new RpcSocket(ws, onClose);
  }

  get open() {
    return this.closedWith === undefined;
  }

  request(tag: string, payload: unknown): Promise<unknown> {
    if (this.closedWith) return Promise.reject(this.closedWith);
    const id = String(this.next++);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ _tag: "Request", id, tag, payload, headers: [] });
    });
  }

  subscribe(tag: string, payload: unknown, item: (value: unknown) => void, end: (error: Error) => void): () => void {
    if (this.closedWith) {
      end(this.closedWith);
      return () => {};
    }
    const id = String(this.next++);
    this.streams.set(id, { item, end });
    this.send({ _tag: "Request", id, tag, payload, headers: [] });
    return () => {
      if (this.streams.delete(id)) this.send({ _tag: "Interrupt", requestId: id });
    };
  }

  close() {
    this.shut(new T3Unreachable("Top closed the connection."));
    try {
      this.ws.close();
    } catch {}
  }

  private send(message: unknown) {
    if (this.closedWith || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(message));
  }

  private receive(data: string) {
    this.heard = Date.now();
    let message: Record<string, unknown>;
    try {
      message = record(JSON.parse(data));
    } catch {
      return;
    }
    const id = message.requestId === undefined ? undefined : String(message.requestId);
    switch (message._tag) {
      case "Chunk": {
        const stream = id === undefined ? undefined : this.streams.get(id);
        if (!stream) return;
        this.send({ _tag: "Ack", requestId: id });
        for (const value of Array.isArray(message.values) ? message.values : []) stream.item(value);
        return;
      }
      case "Exit": {
        const exit = record(message.exit);
        const waiter = id === undefined ? undefined : this.pending.get(id);
        if (waiter) {
          this.pending.delete(id!);
          if (exit._tag === "Success") waiter.resolve(exit.value);
          else waiter.reject(new T3Refused(failureText(exit)));
          return;
        }
        const stream = id === undefined ? undefined : this.streams.get(id);
        if (stream) {
          this.streams.delete(id!);
          stream.end(exit._tag === "Success" ? new T3Unreachable("T3 Code ended the thread's stream.") : new T3Refused(failureText(exit)));
        }
        return;
      }
      case "Defect":
      case "ClientProtocolError":
        this.shut(new T3Unreachable(`T3 Code reported a protocol error: ${JSON.stringify(message.defect ?? message.error ?? "").slice(0, 300)}`));
        try {
          this.ws.close();
        } catch {}
        return;
      default:
        return;
    }
  }

  private shut(error: Error) {
    if (this.closedWith) return;
    this.closedWith = error;
    clearInterval(this.ping);
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
    for (const stream of this.streams.values()) stream.end(error);
    this.streams.clear();
    this.onClose(error);
  }
}
