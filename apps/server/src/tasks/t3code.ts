import { randomUUID } from "node:crypto";
import type { TaskQuestion } from "@top/protocol";
import Type from "typebox";
import { clip, type HarnessAdapter, type HarnessAnswer, type HarnessEvent, HarnessUnavailable, type LogKind, type OpenSpec, type Turn } from "./harness.ts";
import {
  checkProtocol,
  checkSession,
  describe,
  listProjects,
  RpcSocket,
  readT3Config,
  T3AuthError,
  type T3Config,
  type T3Project,
  T3Refused,
  T3Unreachable,
} from "./t3api.ts";

export const T3CODE = "t3code";

export const t3codeOptions = Type.Object(
  {
    provider: Type.Optional(
      Type.String({
        description: "T3 Code's provider instance that runs it, such as claudeAgent or codex. Default: the one that offers `model`, else its first ready one.",
      }),
    ),
  },
  { additionalProperties: false },
);

const NOT_CONNECTED =
  "T3 Code isn't connected to Top. On the daemon's computer run `top t3code connect <T3 Code's address>` with a pairing code from that T3 Code, then try again.";
const RECONNECT_FOR_MS = 10 * 60_000;
const MAX_TRIES = 30;
const TERMINAL_RUN = new Set(["completed", "failed", "cancelled", "interrupted", "rolled_back"]);
const ACTIVE_RUN = new Set(["starting", "running", "waiting"]);
const SETTLED_ITEM = new Set(["completed", "failed", "cancelled", "interrupted"]);

type Rec = Record<string, unknown>;
const record = (value: unknown): Rec => (typeof value === "object" && value !== null ? (value as Rec) : {});
const str = (value: unknown) => (typeof value === "string" ? value : undefined);
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const trimSlash = (path: string) => (path.length > 1 ? path.replace(/[\\/]+$/, "") : path);

function projectList(projects: readonly T3Project[]): string {
  if (!projects.length) return "It has no projects yet; add the folder as a project in T3 Code first.";
  const shown = projects.slice(0, 12).map((p) => `${p.workspaceRoot} (${p.title})`);
  return `Its projects: ${shown.join(", ")}${projects.length > shown.length ? `, and ${projects.length - shown.length} more` : ""}.`;
}

function questionsOf(item: Rec): TaskQuestion[] {
  return (Array.isArray(item.questions) ? item.questions : []).map((raw) => {
    const q = record(raw);
    const id = str(q.id) ?? "answer";
    return {
      id,
      question: str(q.question) ?? id,
      ...(str(q.header) ? { header: str(q.header)! } : {}),
      options: (Array.isArray(q.options) ? q.options : []).map(record).map((o) => ({
        label: str(o.label) ?? "",
        ...(str(o.description) ? { description: str(o.description)! } : {}),
      })),
      ...(q.multiSelect === true ? { multiple: true } : {}),
    };
  });
}

/** T3 Code takes an option's `value` where it has one, else its label or the user's own words; a list for multiple choice. */
export function t3Answers(item: Rec, given: Readonly<Record<string, readonly string[]>>): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const raw of Array.isArray(item.questions) ? item.questions : []) {
    const q = record(raw);
    const id = str(q.id);
    if (!id || !given[id]) continue;
    const options = (Array.isArray(q.options) ? q.options : []).map(record);
    const values = given[id].map((answer) => {
      const option = options.find((o) => str(o.label)?.trim() === answer.trim());
      return option ? (str(option.value) ?? str(option.label)!) : answer;
    });
    out[id] = q.multiSelect === true ? values : values[0]!;
  }
  return out;
}

function itemLog(item: Rec): { kind: LogKind; text: string } | undefined {
  const status = str(item.status);
  const failed = status && status !== "completed" ? ` [${status}]` : "";
  switch (item.type) {
    case "assistant_message":
      return { kind: "message", text: str(item.text) ?? "" };
    case "reasoning":
      return { kind: "reasoning", text: str(item.text) ?? "" };
    case "command_execution": {
      const exit = typeof item.exitCode === "number" ? ` (exit ${item.exitCode})` : "";
      const output = str(item.output)?.trim();
      return { kind: "command", text: `$ ${str(item.input) ?? ""}${exit}${failed}${output ? `\n${clip(output, 600)}` : ""}` };
    }
    case "file_change": {
      const counts = typeof item.additions === "number" || typeof item.deletions === "number" ? ` (+${item.additions ?? 0} -${item.deletions ?? 0})` : "";
      return { kind: "file_change", text: `~ ${str(item.fileName) ?? "?"}${counts}${failed}` };
    }
    case "web_search":
    case "file_search":
    case "dynamic_tool":
      return { kind: "tool", text: `${str(item.title) ?? item.type}${failed}` };
    case "error":
      return { kind: "error", text: str(item.message) ?? str(item.text) ?? str(item.title) ?? "error" };
    case "system_notice":
    case "compaction":
      return { kind: "status", text: str(item.text) ?? str(item.message) ?? str(item.title) ?? String(item.type) };
    default:
      return undefined;
  }
}

export type T3CodeConfig = { readonly file: string; readonly reconnectForMs?: number | undefined };

export function t3codeAdapter(config: T3CodeConfig): HarnessAdapter {
  const reconnectForMs = config.reconnectForMs ?? RECONNECT_FOR_MS;
  const load = async (): Promise<T3Config> => {
    const found = await readT3Config(config.file).catch((error: unknown) => {
      throw new HarnessUnavailable(`Top couldn't read its T3 Code connection (${config.file}): ${message(error)}`);
    });
    if (!found) throw new HarnessUnavailable(NOT_CONNECTED);
    return found;
  };
  /** Checks the address still answers as the environment Top paired with before any credential goes to it. */
  const verify = async (cfg: T3Config) => {
    const descriptor = await describe(cfg.url);
    checkProtocol(cfg.url, descriptor);
    if (descriptor.environmentId !== cfg.environmentId)
      throw new T3AuthError(
        `${cfg.url} answers as ${cfg.environmentId ? "a different T3 Code environment" : "a T3 Code environment Top didn't record"} (${descriptor.label}), so Top didn't send it the credential. If that's intended, pair again with \`top t3code connect ${cfg.url}\`.`,
      );
    return descriptor;
  };

  return {
    id: T3CODE,
    label: "T3 Code",
    capabilities: {
      resume: true,
      fork: false,
      steer: true,
      queue: true,
      questions: true,
      images: false,
      fileChanges: true,
      usage: false,
      cancel: true,
      reconnect: true,
      durable: true,
    },
    options: t3codeOptions,
    check: async () => {
      try {
        const cfg = await load();
        const descriptor = await verify(cfg);
        await checkSession(cfg.url, cfg.token);
        return { ok: true, version: `${descriptor.serverVersion} on ${descriptor.label} (${cfg.url})` };
      } catch (error) {
        return { ok: false, error: message(error) };
      }
    },
    locate: async (cwd) => {
      const cfg = await load();
      await verify(cfg);
      const projects = await listProjects(cfg.url, cfg.token);
      if (cwd === undefined) {
        if (projects.length === 1) return projects[0]!.workspaceRoot;
        throw new Error(`Say which T3 Code project it works in with \`cwd\`, a folder on ${cfg.label}. ${projectList(projects)}`);
      }
      if (!cwd.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(cwd))
        throw new Error(`For T3 Code, \`cwd\` is a folder on ${cfg.label}: give its absolute path. ${projectList(projects)}`);
      const found = projects.find((p) => trimSlash(p.workspaceRoot) === trimSlash(cwd));
      if (!found) throw new Error(`T3 Code on ${cfg.label} has no project at ${cwd}. ${projectList(projects)}`);
      return found.workspaceRoot;
    },
    open: async (spec, emit) => {
      const cfg = await load();
      return openThread(cfg, spec, emit, { verify, reconnectForMs });
    },
  };
}

type Current = {
  readonly key: string;
  readonly messageId: string;
  runId: string | undefined;
  done: boolean;
  readonly asked: Set<string>;
  readonly settled: Set<string>;
  readonly answered: Set<string>;
  readonly logged: Set<string>;
};

async function openThread(
  cfg: T3Config,
  spec: OpenSpec,
  emit: (event: HarnessEvent) => void,
  options: { readonly verify: (cfg: T3Config) => Promise<unknown>; readonly reconnectForMs: number },
) {
  const origin = cfg.url;
  const threadId = spec.resume ?? `top-${spec.session}`;
  let threadExists = spec.resume !== undefined;
  let socket: RpcSocket | undefined;
  let connecting: Promise<RpcSocket> | undefined;
  let lostSince: number | undefined;
  let closed = false;
  let exited = false;
  let lastSequence: number | undefined;
  let following: Promise<void> | undefined;
  let unsubscribe: (() => void) | undefined;
  const runs = new Map<string, Rec>();
  const items = new Map<string, Rec>();
  const sentMessages = new Set<string>();
  let current: Current | undefined;
  let sending: Promise<unknown> | undefined;

  const exit = (error: string) => {
    if (exited || closed) return;
    exited = true;
    emit({ type: "exited", error });
  };

  const connect = (): Promise<RpcSocket> => {
    if (socket?.open) return Promise.resolve(socket);
    connecting ??= (async () => {
      lostSince ??= Date.now();
      const since = lostSince;
      let delay = 500;
      for (;;) {
        if (closed) throw new T3Unreachable("Top closed its connection to T3 Code.");
        try {
          await options.verify(cfg);
          const opened: RpcSocket = await RpcSocket.open(origin, cfg.token, (error) => {
            if (socket === opened) lost(error);
          });
          socket = opened;
          lostSince = undefined;
          return opened;
        } catch (error) {
          if (!(error instanceof T3Unreachable)) throw error;
          if (Date.now() - since >= options.reconnectForMs)
            throw new Error(
              `Lost T3 Code at ${origin} for ${Math.round(options.reconnectForMs / 60_000)} min (${error.message}). Its thread ${threadId} may still be running there.`,
            );
          await new Promise((resolve) => setTimeout(resolve, delay));
          delay = Math.min(delay * 2, 15_000);
        }
      }
    })().finally(() => {
      connecting = undefined;
    });
    return connecting;
  };

  const lost = (error: Error) => {
    socket = undefined;
    following = undefined;
    unsubscribe = undefined;
    if (closed || exited) return;
    emit({ type: "log", kind: "status", text: `lost the connection to T3 Code (${error.message}); reconnecting` });
    if (!threadExists) return;
    followed().then(
      () => emit({ type: "log", kind: "status", text: "reconnected to T3 Code" }),
      (failure: unknown) => exit(message(failure)),
    );
  };

  /** Sends a request until T3 Code answers it. Only for reads and commands whose id makes a repeat a no-op. */
  const request = async (tag: string, payload: unknown): Promise<unknown> => {
    for (let tries = 1; ; tries++) {
      const s = await connect();
      try {
        return await s.request(tag, payload);
      } catch (error) {
        if (!(error instanceof T3Unreachable) || closed || tries >= MAX_TRIES) throw error;
      }
    }
  };
  const command = (payload: Rec) => request("orchestration.dispatchCommand", payload);

  const apply = (event: Rec) => {
    const payload = record(event.payload);
    switch (event.type) {
      case "run.created":
      case "run.updated":
        runs.set(String(payload.id), payload);
        return;
      case "turn-item.updated":
        items.set(String(payload.id), payload);
        return;
      case "message.updated":
        if (payload.role === "user") sentMessages.add(String(payload.id));
        return;
      case "thread.deleted":
        if (current && !current.done) exit(`The T3 Code thread ${threadId} was deleted there.`);
        return;
      default:
        return;
    }
  };

  const evaluate = () => {
    const turn = current;
    if (!turn || turn.done || exited) return;
    if (!turn.runId) for (const run of runs.values()) if (run.userMessageId === turn.messageId) turn.runId = String(run.id);
    if (!turn.runId) return;
    const mine = [...items.values()].filter((i) => i.runId === turn.runId).sort((a, b) => Number(a.ordinal ?? 0) - Number(b.ordinal ?? 0));
    for (const item of mine) {
      const id = String(item.id);
      const requestId = str(item.requestId);
      if (item.type === "user_input_request" && requestId) {
        if (item.status === "waiting" && !turn.asked.has(requestId)) {
          turn.asked.add(requestId);
          const questions = questionsOf(item);
          emit({ type: "request", request: { id: requestId, title: questions[0]?.question ?? "T3 Code asks", questions } });
        } else if (item.status !== "waiting" && !turn.settled.has(requestId)) {
          turn.settled.add(requestId);
          emit({ type: "resolved", id: requestId });
        }
        continue;
      }
      if (item.type === "approval_request" && requestId && item.status === "waiting" && !turn.answered.has(requestId)) {
        turn.answered.add(requestId);
        emit({
          type: "log",
          kind: "error",
          text: `T3 Code asked for approval (${str(item.requestKind) ?? "permission"}${str(item.prompt) ? `: ${clip(str(item.prompt)!, 200)}` : ""}) although Top starts its threads in full access; Top declined it.`,
        });
        command({ type: "runtime-request.respond", commandId: `top:decline:${requestId}`, threadId, requestId, decision: "decline" }).catch((error: unknown) =>
          emit({ type: "log", kind: "error", text: `T3 Code didn't take the decline: ${message(error)}` }),
        );
        continue;
      }
      if ((item.type === "secret_request" || item.type === "link_request") && !turn.logged.has(id)) {
        turn.logged.add(id);
        emit({
          type: "log",
          kind: "status",
          text: `T3 Code asks the user for a ${item.type === "secret_request" ? "secret" : "link"}; it can only be answered in T3 Code.`,
        });
        continue;
      }
      if (SETTLED_ITEM.has(String(item.status)) && item.streaming !== true && !turn.logged.has(id)) {
        turn.logged.add(id);
        const log = itemLog(item);
        if (log?.text.trim()) emit({ type: "log", ...log });
      }
    }
    const run = runs.get(turn.runId);
    const status = str(run?.status);
    if (!status || !TERMINAL_RUN.has(status)) return;
    turn.done = true;
    const answers = mine.filter((i) => i.type === "assistant_message" && i.streaming !== true && str(i.text)?.trim());
    const result = str(answers.at(-1)?.text);
    const error = str(mine.filter((i) => i.type === "error").at(-1)?.message);
    emit({
      type: "turn_ended",
      status: status === "completed" ? "completed" : status === "failed" || status === "rolled_back" ? "failed" : "interrupted",
      ...(result ? { result } : {}),
      ...(status === "completed"
        ? {}
        : { error: error ?? (status === "failed" || status === "rolled_back" ? `T3 Code's run ended as ${status}` : "The turn was stopped in T3 Code.") }),
    });
  };

  const onItem = (raw: unknown) => {
    const item = record(raw);
    if (item.kind === "snapshot") {
      const projection = record(item.projection);
      if (typeof item.snapshotSequence === "number") lastSequence = item.snapshotSequence;
      runs.clear();
      items.clear();
      for (const run of Array.isArray(projection.runs) ? projection.runs : []) runs.set(String(record(run).id), record(run));
      for (const turnItem of Array.isArray(projection.turnItems) ? projection.turnItems : []) items.set(String(record(turnItem).id), record(turnItem));
      for (const m of Array.isArray(projection.messages) ? projection.messages : []) if (record(m).role === "user") sentMessages.add(String(record(m).id));
      const thread = record(projection.thread);
      if (thread.deletedAt) exit(`The T3 Code thread ${threadId} was deleted there.`);
      evaluate();
      return;
    }
    if (typeof item.sequence !== "number") return;
    if (lastSequence !== undefined && item.sequence <= lastSequence) return;
    lastSequence = item.sequence;
    if (item.kind === "event") {
      apply(record(item.event));
      evaluate();
    }
  };

  /** Follows the thread's durable stream: a snapshot first, then every change; after a drop, from where it left off. */
  const follow = (): Promise<void> => {
    if (following) return following;
    const attempt: Promise<void> = (async () => {
      const s = await connect();
      await new Promise<void>((resolve, reject) => {
        let first = true;
        unsubscribe = s.subscribe(
          "orchestration.subscribeThread",
          { threadId, ...(lastSequence !== undefined ? { afterSequence: lastSequence } : {}) },
          (value) => {
            onItem(value);
            if (first) {
              first = false;
              resolve();
            }
          },
          (error) => {
            if (first) reject(error);
            // A dropped socket is picked up again by `lost`; this is a stream that ended on an open one.
            if (!s.open || socket !== s || closed || following !== attempt) return;
            following = undefined;
            if (error instanceof T3Refused) exit(`T3 Code stopped sending thread ${threadId}: ${error.message}`);
            else followed().catch((failure: unknown) => exit(message(failure)));
          },
        );
        if (lastSequence !== undefined) resolve();
      });
    })();
    following = attempt;
    attempt.catch(() => {
      if (following === attempt) following = undefined;
    });
    return attempt;
  };

  /** Follows the thread through drops while T3 Code stays reachable, whoever started the reconnect. */
  const followed = async (): Promise<void> => {
    for (;;) {
      try {
        return await follow();
      } catch (error) {
        if (!(error instanceof T3Unreachable) || closed || exited) throw error;
      }
    }
  };

  type Provider = { readonly instanceId: string; readonly status: string; readonly models: readonly Rec[] };
  const chooseModel = async () => {
    const value = record(await request("server.getConfig", {}));
    const providers: Provider[] = (Array.isArray(value.providers) ? value.providers : [])
      .map(record)
      .filter((p) => p.enabled !== false && str(p.instanceId))
      .map((p) => ({ instanceId: str(p.instanceId)!, status: str(p.status) ?? "unknown", models: (Array.isArray(p.models) ? p.models : []).map(record) }));
    const names = (p: Provider) => p.models.flatMap((m) => [str(m.slug), ...(Array.isArray(m.aliases) ? m.aliases.map(String) : [])]).filter(Boolean);
    const list = () =>
      providers
        .map(
          (p) =>
            `${p.instanceId} (${p.status}: ${
              p.models
                .map((m) => str(m.slug))
                .slice(0, 6)
                .join(", ") || "no models listed"
            })`,
        )
        .join("; ") || "none are on";
    const wanted = str(spec.options.provider);
    const instance = wanted
      ? providers.find((p) => p.instanceId === wanted)
      : spec.model
        ? providers.find((p) => p.status === "ready" && names(p).includes(spec.model!))
        : providers.find((p) => p.status === "ready");
    if (!instance)
      throw new HarnessUnavailable(
        wanted
          ? `T3 Code has no provider "${wanted}" switched on. Its providers: ${list()}.`
          : spec.model
            ? `No ready T3 Code provider offers the model "${spec.model}". Its providers: ${list()}.`
            : `T3 Code has no ready provider. Its providers: ${list()}.`,
      );
    if (instance.status !== "ready") throw new HarnessUnavailable(`T3 Code's ${instance.instanceId} isn't ready there (${instance.status}).`);
    const chosen = spec.model
      ? (instance.models.find((m) => names({ ...instance, models: [m] }).includes(spec.model!)) ?? (instance.models.length ? undefined : { slug: spec.model }))
      : (instance.models.find((m) => m.isDefault === true) ?? instance.models[0]);
    const model = str(chosen?.slug);
    if (!model)
      throw new HarnessUnavailable(
        spec.model
          ? `T3 Code's ${instance.instanceId} has no model "${spec.model}". It has: ${instance.models.map((m) => str(m.slug)).join(", ")}.`
          : `T3 Code's ${instance.instanceId} lists no models.`,
      );
    return { instanceId: instance.instanceId, model };
  };

  const projectFor = async (): Promise<T3Project> => {
    const projects = await listProjects(origin, cfg.token);
    const found = projects.find((p) => trimSlash(p.workspaceRoot) === trimSlash(spec.cwd));
    if (!found) throw new HarnessUnavailable(`T3 Code has no project at ${spec.cwd} anymore. ${projectList(projects)}`);
    return found;
  };

  const runOf = async (turn: Current): Promise<string | undefined> => {
    if (turn.runId) return turn.runId;
    const projection = record(await request("orchestration.getThreadProjection", { threadId }));
    for (const run of Array.isArray(projection.runs) ? projection.runs.map(record) : []) {
      runs.set(String(run.id), run);
      if (run.userMessageId === turn.messageId) turn.runId = String(run.id);
    }
    return turn.runId;
  };

  try {
    await connect();
    if (threadExists) await followed();
  } catch (error: unknown) {
    closed = true;
    socket?.close();
    if (error instanceof HarnessUnavailable) throw error;
    throw new HarnessUnavailable(message(error));
  }

  return {
    run: async (turn: Turn) => {
      if (closed || exited) throw new Error("The connection to T3 Code is closed.");
      if (turn.images.length) throw new Error("Top doesn't send images to T3 Code.");
      const messageId = `top:${turn.key}`;
      current = { key: turn.key, messageId, runId: undefined, done: false, asked: new Set(), settled: new Set(), answered: new Set(), logged: new Set() };
      if (!threadExists) {
        const [selection, project] = await Promise.all([chooseModel(), projectFor()]);
        sending = request("orchestration.launchThread", {
          commandId: messageId,
          threadId,
          projectId: project.id,
          title: clip(turn.text.trim().split("\n")[0]?.trim() || "Task from Top", 80),
          modelSelection: selection,
          runtimeMode: "full-access",
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
          initialMessage: { messageId, text: turn.text, attachments: [] },
        });
        await sending;
        threadExists = true;
        emit({ type: "session", externalId: threadId, model: selection.model });
        await followed();
      } else {
        // A turn sent before a restart is already there; its key keeps a second send from adding it again.
        if (!sentMessages.has(messageId) && ![...runs.values()].some((r) => r.userMessageId === messageId)) {
          sending = command({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: messageId,
            threadId,
            messageId,
            text: turn.text,
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
          });
          await sending;
        }
        await followed();
      }
      evaluate();
    },
    steer: async (text: string) => {
      const turn = current;
      const run = turn?.runId ? runs.get(turn.runId) : undefined;
      if (!turn || turn.done || !run || !ACTIVE_RUN.has(String(run.status))) throw new Error("T3 Code has no turn of this task running to steer.");
      const id = `top:steer:${randomUUID()}`;
      await command({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: id,
        threadId,
        messageId: id,
        text,
        attachments: [],
        dispatchMode: { type: "steer_active", targetRunId: turn.runId },
      });
    },
    interrupt: async () => {
      const turn = current;
      if (!turn || turn.done) return;
      // A stop that comes while the turn is still being sent waits for it, so it finds the run the send made.
      await sending?.catch(() => {});
      const runId = await runOf(turn).catch(() => undefined);
      if (!runId) {
        emit({ type: "log", kind: "error", text: "T3 Code has no run for this turn to stop." });
        return;
      }
      const stop = (type: "run.interrupt" | "queued-run.cancel") =>
        command({ type, commandId: `top:${type === "run.interrupt" ? "stop" : "unqueue"}:${runId}`, threadId, runId });
      try {
        if (runs.get(runId)?.status !== "queued") await stop("run.interrupt");
        else
          await stop("queued-run.cancel").catch(async (error: unknown) => {
            // It started between the look and the cancel: stop it running instead.
            if (!(error instanceof T3Refused)) throw error;
            await stop("run.interrupt");
          });
      } catch (error) {
        emit({ type: "log", kind: "error", text: `T3 Code didn't take the stop: ${message(error)}` });
      }
    },
    answer: (requestId: string, answer: HarnessAnswer) => {
      if (answer.kind !== "question") return;
      const item = [...items.values()].find((i) => i.type === "user_input_request" && i.requestId === requestId) ?? {};
      command({ type: "runtime-request.respond", commandId: `top:answer:${requestId}`, threadId, requestId, answers: t3Answers(item, answer.answers) }).catch(
        (error: unknown) => emit({ type: "log", kind: "error", text: `T3 Code didn't take the answer: ${message(error)}` }),
      );
    },
    close: async () => {
      closed = true;
      unsubscribe?.();
      socket?.close();
    },
  };
}
