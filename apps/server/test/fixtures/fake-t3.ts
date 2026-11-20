// A T3 Code server in miniature: the HTTP auth routes and the /ws RPC (Effect RPC's JSON frames) that
// the t3code adapter uses, with T3 Code's command receipts and sequenced thread stream, plus faults.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { type WebSocket, WebSocketServer } from "ws";

type Rec = Record<string, unknown>;
type Thread = { id: string; projectId: string; events: { sequence: number; event: Rec }[]; runs: Map<string, Rec>; items: Map<string, Rec>; messages: Rec[] };

export type FakeT3 = Awaited<ReturnType<typeof fakeT3>>;

export async function fakeT3(options: { environmentId?: string; protocol?: number; projects?: { id: string; workspaceRoot: string }[] } = {}) {
  let token = "good-token";
  let environmentId = options.environmentId ?? "env-1";
  const tickets = new Set<string>();
  const threads = new Map<string, Thread>();
  const receipts = new Map<string, unknown>();
  const requests: { tag: string; payload: Rec }[] = [];
  const sockets = new Set<WebSocket>();
  const subscribers = new Map<string, Set<(item: Rec) => void>>();
  let sequence = 0;
  const faults = {
    dropReplyTo: undefined as string | undefined,
    dropAfterReplyTo: undefined as string | undefined,
    duplicateEnds: false,
    configDelayMs: 0,
    dropOnOpen: false,
    silent: false,
    silentTypes: new Set<string>(),
    refuseAnswer: undefined as string | undefined,
  };
  const hits: { path: string; authorized: boolean }[] = [];
  const projects = options.projects ?? [{ id: "p1", workspaceRoot: "/srv/app" }];

  const emit = (thread: Thread, event: Rec) => {
    const entry = { sequence: ++sequence, event };
    thread.events.push(entry);
    for (const send of subscribers.get(thread.id) ?? []) send({ kind: "event", ...entry });
  };
  const item = (thread: Thread, runId: string, fields: Rec) => {
    const value: Rec = { threadId: thread.id, runId, ordinal: thread.items.size, streaming: false, ...fields };
    thread.items.set(String(value.id), value);
    emit(thread, { type: "turn-item.updated", payload: value });
  };
  const setRun = (thread: Thread, runId: string, status: string) => {
    const run = { ...thread.runs.get(runId)!, status };
    thread.runs.set(runId, run);
    emit(thread, { type: "run.updated", payload: run });
    if (faults.duplicateEnds && ["completed", "failed", "interrupted"].includes(status)) emit(thread, { type: "run.updated", payload: run });
  };
  const active = (thread: Thread) => [...thread.runs.values()].find((r) => ["queued", "running", "waiting"].includes(String(r.status)));

  /** How a run plays out, from its text: "question" asks, "forever" runs until stopped, anything else answers. */
  const play = (thread: Thread, runId: string, text: string) => {
    setRun(thread, runId, "running");
    if (text.includes("forever")) return;
    if (text.includes("question")) {
      const requestId = `rr-${runId}`;
      item(thread, runId, {
        id: `uir-${runId}`,
        type: "user_input_request",
        requestId,
        status: "waiting",
        questions: [
          {
            id: "color",
            header: "Colour",
            question: "Which colour?",
            options: [
              { label: "Red", description: "warm", value: "red" },
              { label: "Blue", description: "" },
            ],
          },
        ],
      });
      setRun(thread, runId, "waiting");
      return;
    }
    setTimeout(() => finish(thread, runId, `done: ${text}`), 20);
  };
  const finish = (thread: Thread, runId: string, text: string, status = "completed") => {
    if (text) item(thread, runId, { id: `am-${runId}-${thread.items.size}`, type: "assistant_message", status: "completed", text });
    setRun(thread, runId, status);
    const next = [...thread.runs.values()].find((r) => r.status === "queued");
    if (next) play(thread, String(next.id), String(next.text));
  };
  const addRun = (thread: Thread, messageId: string, text: string) => {
    const runId = `run:${thread.id}:${thread.runs.size + 1}`;
    const busy = active(thread);
    const run = { id: runId, threadId: thread.id, userMessageId: messageId, status: busy ? "queued" : "starting", text };
    thread.runs.set(runId, run);
    thread.messages.push({ id: messageId, role: "user", text });
    emit(thread, { type: "message.updated", payload: { id: messageId, role: "user", text, runId } });
    emit(thread, { type: "run.created", payload: run });
    if (!busy) setTimeout(() => play(thread, runId, text), 5);
  };

  const handle = (tag: string, payload: Rec): unknown => {
    switch (tag) {
      case "server.getConfig":
        return {
          providers: [
            {
              instanceId: "claudeAgent",
              enabled: true,
              status: "ready",
              models: [
                { slug: "claude-haiku-5-5", aliases: ["haiku"] },
                { slug: "claude-opus-5-5", isDefault: true },
              ],
            },
            { instanceId: "codex", enabled: true, status: "error", models: [{ slug: "gpt-6.1-sol" }] },
          ],
        };
      case "orchestration.launchThread": {
        const done = receipts.get(String(payload.commandId));
        if (done) return { ...(done as Rec), resumed: true };
        const id = String(payload.threadId);
        const thread: Thread = { id, projectId: String(payload.projectId), events: [], runs: new Map(), items: new Map(), messages: [] };
        threads.set(id, thread);
        const initial = payload.initialMessage as Rec;
        addRun(thread, String(initial.messageId), String(initial.text));
        const result = { threadId: id, projection: {}, resumed: false, sequence };
        receipts.set(String(payload.commandId), result);
        return result;
      }
      case "orchestration.dispatchCommand": {
        const done = receipts.get(String(payload.commandId));
        if (done) return done;
        const thread = threads.get(String(payload.threadId));
        if (!thread) throw new Error("Thread not found.");
        switch (payload.type) {
          case "message.dispatch": {
            const mode = payload.dispatchMode as Rec;
            if (mode.type === "steer_active") {
              const run = thread.runs.get(String(mode.targetRunId));
              if (!run || !["running", "waiting"].includes(String(run.status))) throw new Error("The run isn't active.");
              item(thread, String(run.id), { id: `steer-${payload.messageId}`, type: "user_message", status: "completed", text: payload.text });
            } else addRun(thread, String(payload.messageId), String(payload.text));
            break;
          }
          case "run.interrupt":
          case "queued-run.cancel": {
            const run = thread.runs.get(String(payload.runId));
            if (run && !["completed", "failed", "interrupted", "cancelled"].includes(String(run.status)))
              setTimeout(() => finish(thread, String(run.id), "", payload.type === "run.interrupt" ? "interrupted" : "cancelled"), 5);
            break;
          }
          case "runtime-request.respond": {
            const uir = [...thread.items.values()].find((i) => i.requestId === payload.requestId);
            if (uir?.status !== "waiting") throw new Error("That request isn't pending.");
            const answers = payload.answers as Rec;
            if (faults.refuseAnswer && JSON.stringify(answers).includes(faults.refuseAnswer))
              throw new Error(`"${faults.refuseAnswer}" isn't an answer this takes.`);
            const value = { ...uir, status: "completed" };
            thread.items.set(String(uir.id), value);
            emit(thread, { type: "turn-item.updated", payload: value });
            setTimeout(() => finish(thread, String(uir.runId), `answer: ${JSON.stringify(answers)}`), 5);
            break;
          }
          default:
            throw new Error(`fake T3 doesn't do ${String(payload.type)}`);
        }
        const result = { sequence };
        receipts.set(String(payload.commandId), result);
        return result;
      }
      case "orchestration.getThreadProjection": {
        const thread = threads.get(String(payload.threadId));
        if (!thread) throw new Error("Thread not found.");
        return { runs: [...thread.runs.values()] };
      }
      default:
        throw new Error(`fake T3 doesn't serve ${tag}`);
    }
  };

  const snapshot = (thread: Thread) => ({
    kind: "snapshot",
    snapshotSequence: thread.events.at(-1)?.sequence ?? 0,
    projection: {
      thread: { id: thread.id, deletedAt: null },
      runs: [...thread.runs.values()],
      turnItems: [...thread.items.values()],
      messages: thread.messages,
    },
  });

  const onSocket = (ws: WebSocket) => {
    if (faults.dropOnOpen) {
      setTimeout(() => ws.terminate(), 10);
      return;
    }
    sockets.add(ws);
    ws.on("close", () => sockets.delete(ws));
    const unsubscribes: (() => void)[] = [];
    ws.on("close", () => {
      for (const stop of unsubscribes) stop();
    });
    const send = (message: unknown) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(message));
    ws.on("message", (data) => {
      const message = JSON.parse(String(data)) as Rec;
      if (message._tag === "Ping") return send({ _tag: "Pong" });
      if (message._tag !== "Request") return;
      const id = message.id;
      const tag = String(message.tag);
      const payload = (message.payload ?? {}) as Rec;
      requests.push({ tag, payload });
      if (faults.silent || faults.silentTypes.has(String(payload.type))) return;
      if (tag === "orchestration.subscribeThread") {
        const thread = threads.get(String(payload.threadId));
        if (!thread)
          return send({ _tag: "Exit", requestId: id, exit: { _tag: "Failure", cause: [{ _tag: "Fail", error: { message: "Thread not found." } }] } });
        const out = (item: Rec) => send({ _tag: "Chunk", requestId: id, values: [item] });
        if (typeof payload.afterSequence === "number") {
          for (const entry of thread.events.filter((e) => e.sequence > (payload.afterSequence as number))) out({ kind: "event", ...entry });
        } else out(snapshot(thread));
        if (payload.requestCompletionMarker === true) out({ kind: "synchronized" });
        const set = subscribers.get(thread.id) ?? new Set();
        subscribers.set(thread.id, set);
        set.add(out);
        unsubscribes.push(() => set.delete(out));
        return;
      }
      if (tag === "server.getConfig" && faults.configDelayMs) {
        const delay = faults.configDelayMs;
        faults.configDelayMs = 0;
        setTimeout(() => send({ _tag: "Exit", requestId: id, exit: { _tag: "Success", value: handle(tag, payload) } }), delay);
        return;
      }
      let exit: Rec;
      try {
        exit = { _tag: "Success", value: handle(tag, payload) };
      } catch (error) {
        exit = { _tag: "Failure", cause: [{ _tag: "Fail", error: { message: (error as Error).message } }] };
      }
      if (faults.dropReplyTo && (tag === faults.dropReplyTo || payload.type === faults.dropReplyTo)) {
        faults.dropReplyTo = undefined;
        ws.terminate();
        return;
      }
      send({ _tag: "Exit", requestId: id, exit });
      if (faults.dropAfterReplyTo && tag === faults.dropAfterReplyTo) {
        faults.dropAfterReplyTo = undefined;
        ws.terminate();
      }
    });
  };

  const wss = new WebSocketServer({ noServer: true });
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const authorized = (req: IncomingMessage) => req.headers.authorization === `Bearer ${token}`;
  const http = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    hits.push({ path: url.pathname, authorized: req.headers.authorization !== undefined });
    if (url.pathname === "/.well-known/t3/environment")
      return json(res, 200, {
        environmentId,
        label: "fake",
        serverVersion: "0.0.0-fake",
        orchestrationProtocolVersion: options.protocol ?? 2,
        capabilities: {},
      });
    if (url.pathname === "/api/auth/session")
      return json(res, 200, authorized(req) ? { authenticated: true, scopes: ["orchestration:read", "orchestration:operate"] } : { authenticated: false });
    if (url.pathname === "/api/auth/websocket-ticket/rpc" && req.method === "POST") {
      if (!authorized(req)) return json(res, 401, { code: "auth_invalid" });
      const ticket = `ticket-${Math.random()}`;
      tickets.add(ticket);
      return json(res, 200, { ticket, expiresAt: new Date(Date.now() + 60_000).toISOString() });
    }
    if (url.pathname === "/api/projects") {
      if (!authorized(req)) return json(res, 401, { code: "auth_invalid" });
      return json(res, 200, { projects: projects.map((p) => ({ ...p, title: p.id, archivedAt: null })) });
    }
    json(res, 404, {});
  });
  http.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://x");
    const ticket = url.searchParams.get("wsTicket") ?? "";
    if (url.pathname !== "/ws" || url.searchParams.get("orchestrationProtocol") !== "2" || !tickets.delete(ticket)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, onSocket);
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;

  return {
    origin,
    token: () => token,
    threads,
    requests,
    faults,
    hits,
    /** Like the user stopping or finishing a run in T3 Code itself. */
    finish: (threadId: string, runId: string, text: string, status = "completed") => finish(threads.get(threadId)!, runId, text, status),
    runsOf: (threadId: string) => [...(threads.get(threadId)?.runs.values() ?? [])],
    dropSockets: () => {
      for (const ws of sockets) ws.terminate();
    },
    revoke: () => {
      token = "revoked";
    },
    rotate: (next: string) => {
      token = next;
    },
    setEnvironment: (id: string) => {
      environmentId = id;
    },
    close: async () => {
      for (const ws of sockets) ws.terminate();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
