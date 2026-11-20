import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { TaskQuestion } from "@top/protocol";
import Type from "typebox";
import { duration } from "../time.ts";
import { type HarnessAdapter, type HarnessAnswer, type HarnessEvent, HarnessUnavailable, type LogKind, type OpenSpec, type Turn } from "./harness.ts";
import {
  checkSession,
  listProjects,
  RpcSocket,
  readT3Config,
  type T3Config,
  T3NotSent,
  type T3Project,
  T3Refused,
  T3Unreachable,
  threadKnown,
  verifyEnvironment,
} from "./t3api.ts";

export const T3CODE = "t3code";

class StoppedBeforeSend extends Error {}
const STOPPED = Symbol("stopped");
const stoppedFirst = (error: unknown) => {
  if (error instanceof StoppedBeforeSend) return STOPPED;
  throw error;
};

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
  "T3 Code isn't connected to Top. Connect it in Top's Settings → T3 Code (or with `top t3code connect <T3 Code's address>` on the daemon's computer), with a pairing code from that T3 Code, then try again.";
const RECONNECT_FOR_MS = 10 * 60_000;
const REPLY_MS = 60_000;
const SETTLE_MS = 10_000;
const TERMINAL_RUN = new Set(["completed", "failed", "cancelled", "interrupted", "rolled_back"]);
const ACTIVE_RUN = new Set(["preparing", "starting", "running", "waiting"]);
const SETTLED_ITEM = new Set(["completed", "failed", "cancelled", "interrupted"]);
const ACTIVE_WORK = new Set(["pending", "running", "waiting"]);

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

/**
 * Top numbers the questions itself (q1, q2, …, in T3 Code's order, so a restart numbers them the same): T3 Code's ids are
 * provider text, often the question itself, and would reach the bot unscrubbed. `t3Answers` maps them back.
 */
function questionsOf(item: Rec): TaskQuestion[] {
  return (Array.isArray(item.questions) ? item.questions : []).map((raw, i) => {
    const q = record(raw);
    return {
      id: `q${i + 1}`,
      question: str(q.question) ?? str(q.header) ?? "Question",
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
  for (const [i, raw] of (Array.isArray(item.questions) ? item.questions : []).entries()) {
    const q = record(raw);
    const id = str(q.id);
    const answers = given[`q${i + 1}`];
    if (!id || !answers) continue;
    const options = (Array.isArray(q.options) ? q.options : []).map(record);
    const values = answers.map((answer) => {
      const option = options.find((o) => str(o.label)?.trim() === answer.trim());
      return option ? (str(option.value) ?? str(option.label)!) : answer;
    });
    out[id] = q.multiSelect === true ? values : values[0]!;
  }
  return out;
}

export function itemLog(item: Rec): { kind: LogKind; text: string } | undefined {
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
      // Whole: Top hides saved secrets before it clips, and a clip here could cut one in half first.
      return { kind: "command", text: `$ ${str(item.input) ?? ""}${exit}${failed}${output ? `\n${output}` : ""}` };
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

export type T3CodeConfig = {
  readonly file: string;
  readonly reconnectForMs?: number | undefined;
  /** How long a socket may go without answering a request, or without catching up a thread's stream, before Top drops it. */
  readonly replyMs?: number | undefined;
  /** How long a cancelled turn that may have been sent before a restart gets to show up in T3 Code before it counts as unsent. */
  readonly settleMs?: number | undefined;
};

export function t3codeAdapter(config: T3CodeConfig): HarnessAdapter {
  const reconnectForMs = config.reconnectForMs ?? RECONNECT_FOR_MS;
  const load = async (): Promise<T3Config> => {
    const found = await readT3Config(config.file).catch((error: unknown) => {
      throw new HarnessUnavailable(`Top couldn't read its T3 Code connection (${config.file}): ${message(error)}`);
    });
    if (!found) throw new HarnessUnavailable(NOT_CONNECTED);
    return found;
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
    // Connecting or disconnecting (in Settings or with `top t3code`) reaches the bots from their next message, no restart needed.
    offered: () => existsSync(config.file),
    check: async () => {
      try {
        const cfg = await load();
        const descriptor = await verifyEnvironment(cfg);
        await checkSession(cfg.url, cfg.token);
        return { ok: true, version: `${descriptor.serverVersion} on ${cfg.label} (${cfg.url})` };
      } catch (error) {
        return { ok: false, error: message(error) };
      }
    },
    locate: async (cwd) => {
      const cfg = await load();
      await verifyEnvironment(cfg);
      const projects = await listProjects(cfg.url, cfg.token);
      // The session belongs to this environment: pairing Top with another one later never sends its turns there.
      const bound = (root: string) => ({ cwd: root, options: { environment: cfg.environmentId } });
      if (cwd === undefined) {
        if (projects.length === 1) return bound(projects[0]!.workspaceRoot);
        throw new Error(`Say which T3 Code project it works in with \`cwd\`, a folder on ${cfg.label}. ${projectList(projects)}`);
      }
      if (!cwd.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(cwd))
        throw new Error(`For T3 Code, \`cwd\` is a folder on ${cfg.label}: give its absolute path. ${projectList(projects)}`);
      const found = projects.find((p) => trimSlash(p.workspaceRoot) === trimSlash(cwd));
      if (!found) throw new Error(`T3 Code on ${cfg.label} has no project at ${cwd}. ${projectList(projects)}`);
      return bound(found.workspaceRoot);
    },
    open: async (spec, emit) => {
      const cfg = await load();
      const environment = str(spec.options.environment);
      if (environment && environment !== cfg.environmentId)
        throw new HarnessUnavailable(
          `This session belongs to the T3 Code environment it started on (${environment}), and Top is now paired with another one (${cfg.label}), so nothing was sent there. Pair Top with that one again to carry on.`,
        );
      return openThread(cfg, spec, emit, {
        verify: verifyEnvironment,
        reconnectForMs,
        replyMs: config.replyMs ?? REPLY_MS,
        settleMs: config.settleMs ?? SETTLE_MS,
      });
    },
  };
}

type Current = {
  readonly key: string;
  readonly messageId: string;
  runId: string | undefined;
  done: boolean;
  /** Its run ended while the thread's delegated work went on: the turn ends when that settles. */
  holding: boolean;
  /** Followed after a restart only to carry out a cancel: the cancel, not its run's end, decides how it ends. */
  readonly followOnly: boolean;
  /** Stopped from Top while it held: it ends as stopped, not as its run's earlier answer, once T3 Code took the stop. */
  cut: "sending" | "confirmed" | undefined;
  readonly asked: Set<string>;
  readonly settled: Set<string>;
  readonly answered: Set<string>;
  readonly logged: Set<string>;
  stopped: boolean;
};

async function openThread(
  cfg: T3Config,
  spec: OpenSpec,
  emit: (event: HarnessEvent) => void,
  options: { readonly verify: (cfg: T3Config) => Promise<unknown>; readonly reconnectForMs: number; readonly replyMs: number; readonly settleMs: number },
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
  // What T3 Code settles a thread's delegated work by: its tasks, its provider threads' background work, and the runs
  // that only acknowledge a monitor's progress (never a turn's answer).
  const subagents = new Map<string, Rec>();
  const providerThreads = new Map<string, Rec>();
  const monitorRuns = new Set<string>();
  const noteMessage = (m: Rec) => {
    if (m.role !== "user") return;
    sentMessages.add(String(m.id));
    const notification = record(m.notification);
    if (record(notification.source).kind === "monitor" && notification.outcome === "updated" && str(m.runId)) monitorRuns.add(str(m.runId)!);
  };
  let current: Current | undefined;
  let sending: Promise<unknown> | undefined;
  const settle = () => new Promise((resolve) => setTimeout(resolve, options.settleMs));

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
      let why = "it kept dropping";
      for (;;) {
        if (closed) throw new T3Unreachable("Top closed its connection to T3 Code.");
        // The window runs from the first drop until T3 Code answers, across sockets that open and drop again.
        if (Date.now() - since >= options.reconnectForMs)
          throw new Error(`Lost T3 Code at ${origin} for ${duration(options.reconnectForMs)} (${why}). Its thread ${threadId} may still be running there.`);
        try {
          await options.verify(cfg);
          const opened: RpcSocket = await RpcSocket.open(origin, cfg.token, (error) => {
            if (socket === opened) lost(error);
          });
          if (closed) {
            // The harness ended while this reconnect was on its way.
            opened.close();
            throw new T3Unreachable("Top closed its connection to T3 Code.");
          }
          socket = opened;
          return opened;
        } catch (error) {
          if (!(error instanceof T3Unreachable) || closed) throw error;
          why = error.message;
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

  /**
   * Sends a request until T3 Code answers it. Only for reads and commands whose id makes a repeat a no-op.
   * `stopped` is asked before each attempt until one has left Top, however long reconnecting took; once sent, it's seen through.
   * A socket that doesn't answer in time is dropped, so the reconnect window applies.
   */
  const request = async (tag: string, payload: unknown, stopped?: () => boolean): Promise<unknown> => {
    let sent = false;
    let why = "no answer yet";
    const since = Date.now();
    // One window for the whole request, across reconnecting, backing off and waiting for the reply.
    const left = () => options.reconnectForMs - (Date.now() - since);
    const expired = () =>
      new Error(`T3 Code didn't answer ${tag} for ${duration(options.reconnectForMs)} (${why}). Its thread ${threadId} may still be running there.`);
    for (let tries = 1; ; tries++) {
      if (left() <= 0) throw expired();
      // A reconnect someone else started counts against this request's window too.
      let waited: NodeJS.Timeout | undefined;
      const s = await Promise.race([
        connect(),
        new Promise<never>((_, reject) => {
          waited = setTimeout(() => reject(expired()), left());
        }),
      ]).finally(() => clearTimeout(waited));
      if (!sent && stopped?.()) throw new StoppedBeforeSend();
      if (left() <= 0) throw expired();
      try {
        const asked = s.request(tag, payload);
        let timer: NodeJS.Timeout | undefined;
        const reply = await Promise.race([
          asked,
          new Promise((_, reject) => {
            timer = setTimeout(
              () => {
                s.close();
                reject(new T3Unreachable(`T3 Code didn't answer ${tag} in time.`));
              },
              Math.min(options.replyMs, left()),
            );
          }),
        ]).finally(() => clearTimeout(timer));
        // Reachable again only once T3 Code answers, not when a socket merely opens.
        lostSince = undefined;
        return reply;
      } catch (error) {
        if (!(error instanceof T3NotSent)) sent = true;
        if (!(error instanceof T3Unreachable) || closed) throw error;
        why = error.message;
        // The window, not a count, ends this; a thread's stream catching up says nothing about this request.
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(250 * tries, 5_000, left()))));
      }
    }
  };
  const command = (payload: Rec, stopped?: () => boolean) => request("orchestration.dispatchCommand", payload, stopped);

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
        noteMessage(payload);
        return;
      case "subagent.updated":
        subagents.set(String(payload.id), payload);
        return;
      case "provider-thread.updated":
        providerThreads.set(String(payload.id), payload);
        return;
      case "thread.deleted":
        if (current && !current.done) exit(`The T3 Code thread ${threadId} was deleted there.`);
        return;
      default:
        return;
    }
  };

  const startOf = (r: Rec) => (str(r.startedAt) ? Date.parse(str(r.startedAt)!) : Number.POSITIVE_INFINITY);
  /**
   * The turn's own run and every run after it in the thread, such as the ones T3 Code wakes it with when delegated work
   * reports back: numbered after it, or started after it (T3 Code may run a held, lower-numbered one later), in the
   * order they ran. Not a monitor's progress runs: their questions and answers aren't the task's.
   */
  const turnRuns = (turn: Current): Rec[] => {
    const own = turn.runId ? runs.get(turn.runId) : undefined;
    if (!own) return [];
    const from = Number(own.ordinal);
    const later = (r: Rec) => (Number.isFinite(from) && Number(r.ordinal) > from) || (str(own.startedAt) !== undefined && startOf(r) >= startOf(own));
    return [...runs.values()]
      .filter((r) => r === own || (later(r) && !monitorRuns.has(String(r.id))))
      .sort((a, b) => startOf(a) - startOf(b) || Number(a.ordinal) - Number(b.ordinal));
  };
  const ended = (run: Rec) => TERMINAL_RUN.has(String(run.status));
  const ranAfter = (a: Rec, b: Rec) => {
    const end = (r: Rec) => (str(r.completedAt) ? Date.parse(str(r.completedAt)!) : Number.POSITIVE_INFINITY);
    return end(a) === end(b) ? Number(a.ordinal) > Number(b.ordinal) : end(a) > end(b);
  };

  /**
   * What still keeps the thread's answer owed, as T3 Code settles a thread's delegated work: a run that isn't over, a
   * delegated task still working or whose result hasn't woken its owner yet, or background work the agent waits on.
   * Thread-wide, so a task an earlier run delegated counts too. A count, for the log; 0 when it has settled.
   */
  const delegatedWork = () => {
    const working = [...runs.values()].filter(
      (r) => !monitorRuns.has(String(r.id)) && r.status !== "rolled_back" && !ended(r) && !(r.status === "queued" && r.queueHeld === true),
    ).length;
    const tasks = [...subagents.values()].filter((t) => {
      const delivery = str(record(t.completionDelivery).state);
      return ACTIVE_WORK.has(String(t.status)) || (t.status !== "idle" && (delivery === "pending" || delivery === "claimed"));
    }).length;
    const background = [...providerThreads.values()]
      .flatMap((t) => (Array.isArray(t.pendingBackgroundTasks) ? t.pendingBackgroundTasks.map(record) : []))
      .filter((t) => t.awaited === true || t.kind === "subagent" || t.kind === "background_task").length;
    return { working, delegated: tasks + background };
  };

  /**
   * Stops the thread, which stops its delegated work and any run it woke, as Stop in T3 Code does; the turn then ends as
   * stopped. The same command after a restart is one stop, so one T3 Code already took counts as taken.
   */
  const cutThread = async (turn: Current) => {
    if (turn.cut) return;
    turn.cut = "sending";
    await command({ type: "thread.stop", commandId: `top:stop-thread:${turn.key}`, threadId, reason: "Cancelled from Top." });
    turn.cut = "confirmed";
    evaluate();
  };

  const evaluate = () => {
    const turn = current;
    if (!turn || turn.done || exited) return;
    if (!turn.runId) for (const run of runs.values()) if (run.userMessageId === turn.messageId) turn.runId = String(run.id);
    if (!turn.runId) return;
    const ours = turnRuns(turn);
    const ourIds = new Set(ours.map((r) => String(r.id)));
    const order = new Map(ours.map((r, i) => [String(r.id), i]));
    const mine = [...items.values()]
      .filter((i) => ourIds.has(String(i.runId)))
      .sort((a, b) => order.get(String(a.runId))! - order.get(String(b.runId))! || Number(a.ordinal ?? 0) - Number(b.ordinal ?? 0));
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
          text: `T3 Code asked for approval (${str(item.requestKind) ?? "permission"}${str(item.prompt) ? `: ${str(item.prompt)}` : ""}) although Top starts its threads in full access; Top declined it.`,
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
    const own = runs.get(turn.runId);
    if (!own || !ended(own)) return;
    let outcome = own;
    // Its stop isn't confirmed yet; if it never is, the task's cancel times out instead.
    if (turn.cut === "sending") return;
    if (turn.stopped) {
      // Its run ended, by the stop or on its own before it, with delegated work still going: stop that too.
      if (!turn.cut && delegatedWork().delegated) {
        cutThread(turn).catch((error: unknown) => emit({ type: "log", kind: "error", text: `T3 Code didn't take the stop: ${message(error)}` }));
        return;
      }
      // Stopped from Top: over once nothing it stopped still runs, whatever the delegated work does.
      if (ours.some((r) => !ended(r) && r.status !== "queued")) return;
    } else if (turn.followOnly) {
      return;
    } else if (own.status !== "rolled_back") {
      const { working, delegated } = delegatedWork();
      if (working || delegated) {
        if (!turn.holding && delegated) {
          turn.holding = true;
          emit({
            type: "log",
            kind: "status",
            text: `T3 Code's run ended, but its thread still has delegated work going (${delegated} ${delegated === 1 ? "task" : "tasks"}); Top follows it until that settles.`,
          });
        }
        return;
      }
      // Settled: the answer is the run that ended last, often one T3 Code woke the owner with.
      // A run that never started, like a queued one cancelled, has no answer.
      // Any run in the thread: T3 Code may run a queued one with a lower number after this turn's.
      outcome = [...runs.values()]
        .filter((r) => ended(r) && r.status !== "rolled_back" && !monitorRuns.has(String(r.id)) && r.startedAt != null)
        .reduce((a, b) => (ranAfter(b, a) ? b : a), own);
    }
    turn.done = true;
    const its = [...items.values()].filter((i) => i.runId === outcome.id).sort((a, b) => Number(a.ordinal ?? 0) - Number(b.ordinal ?? 0));
    // Stop in T3 Code while it held: T3 Code records the stop on the run that had already ended, and cancels the work.
    const stoppedThere = turn.holding && its.some((i) => i.type === "run_interrupt_request");
    const status = turn.cut || stoppedThere ? "interrupted" : String(outcome.status);
    const answers = its.filter((i) => i.type === "assistant_message" && i.streaming !== true && str(i.text)?.trim());
    const result = str(answers.at(-1)?.text);
    const error = str(its.filter((i) => i.type === "error").at(-1)?.message);
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
      subagents.clear();
      providerThreads.clear();
      const list = (value: unknown) => (Array.isArray(value) ? value.map(record) : []);
      for (const run of list(projection.runs)) runs.set(String(run.id), run);
      for (const turnItem of list(projection.turnItems)) items.set(String(turnItem.id), turnItem);
      for (const m of list(projection.messages)) noteMessage(m);
      // A T3 Code from before delegated tasks sends neither: nothing holds a turn there.
      for (const task of list(projection.subagents)) subagents.set(String(task.id), task);
      for (const thread of list(projection.providerThreads)) providerThreads.set(String(thread.id), thread);
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
        // Caught up means T3 Code sent the snapshot or the missed events, then its `synchronized` marker.
        const timer = setTimeout(() => {
          if (first) s.close();
        }, options.replyMs);
        unsubscribe = s.subscribe(
          "orchestration.subscribeThread",
          { threadId, requestCompletionMarker: true, ...(lastSequence !== undefined ? { afterSequence: lastSequence } : {}) },
          (value) => {
            onItem(value);
            if (first && record(value).kind === "synchronized") {
              first = false;
              clearTimeout(timer);
              lostSince = undefined;
              resolve();
            }
          },
          (error) => {
            clearTimeout(timer);
            if (first) reject(error);
            // A dropped socket is picked up again by `lost`; this is a stream that ended on an open one.
            if (!s.open || socket !== s || closed || following !== attempt) return;
            following = undefined;
            if (error instanceof T3Refused) exit(`T3 Code stopped sending thread ${threadId}: ${error.message}`);
            else followed().catch((failure: unknown) => exit(message(failure)));
          },
        );
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
      const mine: Current = {
        key: turn.key,
        messageId,
        runId: undefined,
        done: false,
        holding: false,
        followOnly: turn.followOnly === true,
        cut: undefined,
        asked: new Set(),
        settled: new Set(),
        answered: new Set(),
        logged: new Set(),
        stopped: false,
      };
      current = mine;
      /** Sends the turn unless a stop came first; false when it didn't. */
      const send = async () => {
        if (!threadExists && turn.followOnly) {
          // A launch may have reached T3 Code before Top restarted, or still be on its way: look for its thread, twice
          // with a pause between, rather than launch it. Only T3 Code's own "thread_not_found" counts as absent.
          const found = (await threadKnown(origin, cfg.token, threadId)) || (await settle().then(() => threadKnown(origin, cfg.token, threadId)));
          if (!found) return false;
          threadExists = true;
          emit({ type: "session", externalId: threadId });
          await followed();
        }
        if (!threadExists) {
          const [selection, project] = await Promise.all([chooseModel(), projectFor()]);
          if (mine.stopped) return false;
          const launched = request(
            "orchestration.launchThread",
            {
              commandId: messageId,
              threadId,
              projectId: project.id,
              title: spec.title.trim() || "Task from Top",
              modelSelection: selection,
              runtimeMode: "full-access",
              interactionMode: "default",
              workspaceStrategy: { type: "root" },
              initialMessage: { messageId, text: turn.text, attachments: [] },
            },
            () => mine.stopped,
          );
          if ((await launched.catch(stoppedFirst)) === STOPPED) return false;
          threadExists = true;
          emit({ type: "session", externalId: threadId, model: selection.model });
          // A turn sent before a restart is already there; its key keeps a second send from adding it again.
        } else if (!sentMessages.has(messageId) && ![...runs.values()].some((r) => r.userMessageId === messageId)) {
          if (mine.stopped) return false;
          if (turn.followOnly) {
            // Not there yet: give a send that was on its way when Top stopped time to land, then look again.
            await settle();
            // Asked of T3 Code afresh, not the stream's cache, which a drop meanwhile could leave behind.
            const projection = record(await request("orchestration.getThreadProjection", { threadId }));
            const landed = (Array.isArray(projection.runs) ? projection.runs : []).map(record).find((r) => r.userMessageId === messageId);
            // The stream may have reported the run meanwhile; its state is the newer one.
            if (landed && !runs.has(String(landed.id))) runs.set(String(landed.id), landed);
            return landed !== undefined || sentMessages.has(messageId) || [...runs.values()].some((r) => r.userMessageId === messageId);
          }
          const sent = command(
            {
              type: "message.dispatch",
              createdBy: "user",
              creationSource: "web",
              commandId: messageId,
              threadId,
              messageId,
              text: turn.text,
              attachments: [],
              dispatchMode: { type: "queue_after_active" },
            },
            () => mine.stopped,
          );
          if ((await sent.catch(stoppedFirst)) === STOPPED) return false;
        }
        return true;
      };
      sending = send();
      if (!(await sending)) {
        mine.done = true;
        emit({ type: "turn_ended", status: "interrupted", error: "Stopped before it was sent to T3 Code." });
        return;
      }
      await followed();
      evaluate();
    },
    steer: async (text: string) => {
      const turn = current;
      // Its own run, or one T3 Code woke it with when delegated work reported back.
      const run = turn && !turn.done ? turnRuns(turn).find((r) => ACTIVE_RUN.has(String(r.status))) : undefined;
      if (!turn || turn.done || !run) {
        if (turn?.holding)
          throw new Error(
            'T3 Code\'s run for this task ended, and its thread waits on delegated work: no run is there to steer. Send it with mode "queue" to run after.',
          );
        throw new Error("T3 Code has no turn of this task running to steer.");
      }
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
        dispatchMode: { type: "steer_active", targetRunId: run.id },
      });
    },
    interrupt: async () => {
      const turn = current;
      if (!turn || turn.done) return;
      turn.stopped = true;
      // A stop that comes while the turn is still being sent waits for it, so it finds the run the send made.
      await sending?.catch(() => {});
      if (turn.done) return;
      const runId = await runOf(turn).catch(() => undefined);
      if (!runId) {
        emit({ type: "log", kind: "error", text: "T3 Code has no run for this turn to stop." });
        return;
      }
      const stop = (type: "run.interrupt" | "queued-run.cancel") =>
        command({ type, commandId: `top:${type === "run.interrupt" ? "stop" : "unqueue"}:${runId}`, threadId, runId });
      try {
        const own = runs.get(runId);
        if (own && ended(own)) {
          // Its run is over: the turn waits on delegated work, or a cancel from before a restart found it ended.
          await cutThread(turn);
        } else if (own?.status !== "queued") await stop("run.interrupt");
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
    answer: async (requestId: string, answer: HarnessAnswer) => {
      if (answer.kind !== "question") return;
      const item = [...items.values()].find((i) => i.type === "user_input_request" && i.requestId === requestId) ?? {};
      const answers = t3Answers(item, answer.answers);
      // The same answer sent again (after a lost reply or a restart) is one command; a new answer after a refusal is another.
      const version = createHash("sha256").update(JSON.stringify(answers)).digest("hex").slice(0, 16);
      try {
        await command({ type: "runtime-request.respond", commandId: `top:answer:${requestId}:${version}`, threadId, requestId, answers });
      } catch (error) {
        // Refused, or never confirmed while T3 Code still waits on it: the request waits again in Top.
        const still = [...items.values()].find((i) => i.type === "user_input_request" && i.requestId === requestId);
        if (error instanceof T3Refused || still?.status === "waiting") throw error;
        emit({ type: "log", kind: "error", text: `T3 Code didn't confirm the answer, but no longer waits on it: ${message(error)}` });
      }
    },
    close: async () => {
      closed = true;
      unsubscribe?.();
      socket?.close();
    },
  };
}
