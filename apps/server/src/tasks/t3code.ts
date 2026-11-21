import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { TaskQuestion } from "@top/protocol";
import Type from "typebox";
import { duration } from "../time.ts";
import {
  type HarnessAdapter,
  type HarnessAnswer,
  type HarnessEvent,
  HarnessUnavailable,
  type LogKind,
  type OpenSpec,
  type ReviewedRun,
  type SessionWatch,
  type Turn,
  type WatchedThread,
} from "./harness.ts";
import {
  checkSession,
  listProjects,
  RpcSocket,
  readT3Config,
  readThread,
  type T3Config,
  T3NotSent,
  type T3Project,
  T3Refused,
  T3Unreachable,
  threadKnown,
  verifyEnvironment,
} from "./t3api.ts";
import { type Accounted, causes, descendsFrom, isMonitorProgress, owners } from "./t3owner.ts";

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
    watch: (changed) => watchShell(config.file, changed, config.replyMs ?? REPLY_MS),
  };
}

const runsInOrder = (runs: Iterable<Rec>) => {
  const startOf = (r: Rec) => (str(r.startedAt) ? Date.parse(str(r.startedAt)!) : Number.POSITIVE_INFINITY);
  return [...runs].sort((a, b) => startOf(a) - startOf(b) || Number(a.ordinal) - Number(b.ordinal));
};
const mapOf = (list: unknown, keep: (r: Rec) => boolean = () => true) =>
  new Map((Array.isArray(list) ? list.map(record) : []).filter(keep).map((r) => [String(r.id), r]));

/**
 * One subscription to T3 Code's shell, for the whole environment Top is paired with: every thread's latest and active run,
 * so a run T3 Code starts on its own in a Top thread is seen whenever it comes. Read-only. It resumes from where it left
 * off after a drop and takes a fresh snapshot when T3 Code can't replay; it keeps trying while Top runs and fails nothing.
 */
function watchShell(file: string, changed: (threads: readonly WatchedThread[], environment: string) => void, replyMs: number): SessionWatch {
  let closed = false;
  let socket: RpcSocket | undefined;
  let after: number | undefined;
  let environment = "";
  let wake: (() => void) | undefined;
  const pause = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  const shell = (t: Rec, archived: boolean): WatchedThread => ({
    externalId: str(t.id)!,
    archived: archived || t.archivedAt != null || t.deletedAt != null,
    latestRunId: t.latestRunId === null ? null : str(t.latestRunId),
    activeRunId: t.activeRunId === null ? null : str(t.activeRunId),
  });
  const shells = (list: unknown, archived: boolean): WatchedThread[] =>
    (Array.isArray(list) ? list.map(record) : []).filter((t) => str(t.id)).map((t) => shell(t, archived));
  void (async () => {
    let delay = 500;
    while (!closed) {
      try {
        const cfg = await readT3Config(file);
        if (!cfg) throw new T3Unreachable("not connected");
        await verifyEnvironment(cfg);
        // Paired with another T3 Code since: its sequence numbers aren't this one's.
        if (environment && environment !== cfg.environmentId) after = undefined;
        environment = cfg.environmentId;
        const opened = await RpcSocket.open(cfg.url, cfg.token, () => {});
        if (closed) {
          opened.close();
          break;
        }
        socket = opened;
        await new Promise<void>((resolve) => {
          let heard = false;
          const timer = setTimeout(() => {
            if (!heard) opened.close();
          }, replyMs);
          // Paired with another T3 Code meanwhile: start the watch over there.
          const repaired = setInterval(
            () => {
              readT3Config(file).then(
                (now) => {
                  if (now?.environmentId !== cfg.environmentId || now.url !== cfg.url) opened.close();
                },
                () => {},
              );
            },
            Math.max(replyMs, 5_000),
          );
          opened.subscribe(
            "orchestration.subscribeShell",
            { requestCompletionMarker: true, ...(after !== undefined ? { afterSequence: after } : {}) },
            (raw) => {
              const value = record(raw);
              if (!heard) {
                heard = true;
                clearTimeout(timer);
                delay = 500;
              }
              if (value.kind === "snapshot") {
                const snapshot = record(value.snapshot);
                // A snapshot that only adds project details can come ahead of the changes it skips: it moves no cursor.
                if (typeof snapshot.snapshotSequence === "number" && value.resolvedRepositoryIdentityRoots === undefined) after = snapshot.snapshotSequence;
                changed([...shells(snapshot.threads, false), ...shells(snapshot.archivedThreads, true)], environment);
                return;
              }
              if (typeof value.sequence === "number") after = Math.max(after ?? 0, value.sequence);
              if (value.kind === "thread.updated") {
                const thread = record(value.thread);
                if (str(thread.id)) changed([shell(thread, value.location === "archive")], environment);
              }
            },
            () => {
              clearTimeout(timer);
              clearInterval(repaired);
              resolve();
            },
          );
        });
      } catch {}
      socket?.close();
      socket = undefined;
      if (closed) break;
      await pause(delay);
      delay = Math.min(delay * 2, 15_000);
    }
  })();
  return {
    review: async (externalId, accounted: ReadonlyMap<string, Accounted>, from: string | undefined): Promise<readonly ReviewedRun[]> => {
      const cfg = await readT3Config(file);
      if (!cfg) throw new T3Unreachable("T3 Code isn't connected.");
      // A session of a T3 Code Top isn't paired with now: nothing to read here (the watch moves on its own).
      if (from !== undefined && cfg.environmentId !== from) return [];
      const projection = await readThread(cfg.url, cfg.token, externalId);
      const runs = mapOf(projection.runs);
      const ownerOf = owners({ runs, messages: mapOf(projection.messages, (m) => m.role === "user"), subagents: mapOf(projection.subagents) }, accounted);
      return runsInOrder(runs.values()).map((r) => ({ run: String(r.id), ended: TERMINAL_RUN.has(String(r.status)), owner: ownerOf(String(r.id)) }));
    },
    close: () => {
      closed = true;
      socket?.close();
      wake?.();
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
  /** Top's work in the thread that was going while this turn was, though it started first: a wake racing the turn's message. */
  readonly joined: Set<string>;
  /** Runs other tasks already reported: never this turn's. */
  readonly known: ReadonlySet<string>;
  /** Tasks of the session that were cancelled: their work is never this turn's. */
  readonly cancelled: ReadonlySet<string>;
  readonly accounted: ReadonlyMap<string, Accounted>;
  readonly adopted: boolean;
  /** The runs it reported, as they were when it ended; a later run isn't the ended turn's. */
  covered: { readonly runs: readonly string[]; readonly earlier: readonly string[] } | undefined;
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
  // The thread's user-role messages, for whose work each run is: Top's, a person's, or what caused it.
  const messages = new Map<string, Rec>();
  const noteMessage = (m: Rec) => {
    if (m.role !== "user") return;
    sentMessages.add(String(m.id));
    messages.set(String(m.id), m);
    if (isMonitorProgress(m) && str(m.runId)) monitorRuns.add(str(m.runId)!);
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
  /** Runs that started once the turn's own run had: whatever T3 Code ran for it from then on, in the order they ran. */
  const since = (own: Rec) =>
    [...runs.values()]
      .filter((r) => r === own || (str(own.startedAt) !== undefined && startOf(r) >= startOf(own)))
      .sort((a, b) => startOf(a) - startOf(b) || Number(a.ordinal) - Number(b.ordinal));
  /**
   * The turn's own run and Top's runs after it, such as the ones T3 Code wakes it with when delegated work reports back.
   * By when they ran, not their numbers: T3 Code may run a held, lower-numbered one later, or a newer one first. Not a
   * monitor's progress runs, nor a person's turns in T3 Code and what they cause: their questions and answers aren't the
   * task's. Top's work that was already going when the turn began joins it too, so nothing of Top's runs unfollowed.
   */
  const turnRuns = (turn: Current): Rec[] => {
    const own = turn.runId ? runs.get(turn.runId) : undefined;
    if (!own) return [];
    const records = { runs, messages, subagents };
    const ownerOf = owners(records, turn.accounted);
    // A run Top adopted gathers only what came from it: another wake waiting in the session is a continuation of its own.
    const cause = causes(records);
    const related = (r: Rec) => !turn.adopted || descendsFrom(cause, String(r.id), String(own.id));
    // Not work of a task that was cancelled: what T3 Code still does for it isn't reported.
    const live = (o: ReturnType<typeof ownerOf>) => o.kind === "top" && !turn.cancelled.has(o.task ?? o.key?.split(":m")[0] ?? "");
    const top = (r: Rec) => !monitorRuns.has(String(r.id)) && !turn.known.has(String(r.id)) && live(ownerOf(String(r.id))) && related(r);
    for (const r of runs.values()) if (r !== own && str(r.startedAt) && !ended(r) && top(r)) turn.joined.add(String(r.id));
    // A run Top adopted that someone has since written into in T3 Code is theirs now: Top reports none of it.
    const mine = turn.adopted && ownerOf(String(own.id)).kind !== "top" ? [] : [own];
    // Joined runs too, should someone have written into one since.
    const joined = [...turn.joined].map((id) => runs.get(id)).filter((r): r is Rec => r !== undefined && top(r));
    const scope = new Set([...mine, ...since(own).filter(top), ...joined]);
    return runsInOrder(scope);
  };
  const ended = (run: Rec) => TERMINAL_RUN.has(String(run.status));
  /** The runs a turn reported (those of its runs that ended), and, for a session Top first accounts for, the ones before it. */
  const coverage = (turn: Current) => {
    const own = turn.runId ? runs.get(turn.runId) : undefined;
    if (!own) return { runs: [], earlier: [] };
    const start = str(own.startedAt) ? Date.parse(str(own.startedAt)!) : Number.POSITIVE_INFINITY;
    const earlier = [...runs.values()].filter((r) => r !== own && ended(r) && !turn.joined.has(String(r.id)) && Date.parse(str(r.completedAt) ?? "") <= start);
    return {
      runs: turnRuns(turn)
        .filter(ended)
        .map((r) => String(r.id)),
      earlier: earlier.map((r) => String(r.id)),
    };
  };
  const ranAfter = (a: Rec, b: Rec) => {
    const end = (r: Rec) => (str(r.completedAt) ? Date.parse(str(r.completedAt)!) : Number.POSITIVE_INFINITY);
    return end(a) === end(b) ? Number(a.ordinal) > Number(b.ordinal) : end(a) > end(b);
  };

  /**
   * What still keeps the thread's answer owed, as T3 Code settles a thread's delegated work: a run that isn't over, a
   * delegated task still working or whose result hasn't woken its owner yet, or background work the agent waits on.
   * Thread-wide, so a task an earlier run delegated counts too. A count, for the log; 0 when it has settled.
   */
  const delegatedWork = (scope?: ReadonlySet<string>) => {
    const working = [...runs.values()].filter(
      (r) =>
        (!scope || scope.has(String(r.id))) &&
        !monitorRuns.has(String(r.id)) &&
        r.status !== "rolled_back" &&
        !ended(r) &&
        !(r.status === "queued" && r.queueHeld === true),
    ).length;
    const tasks = [...subagents.values()].filter((t) => {
      if (scope && !scope.has(String(t.runId))) return false;
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
    const ours = new Set(turnRuns(turn).map((r) => String(r.id)));
    const going = (r: Rec) => !ended(r) && !monitorRuns.has(String(r.id));
    const working = (t: Rec) => ACTIVE_WORK.has(String(t.status));
    // Stopping the thread stops everything in it and holds its queue: only when nothing there is anyone else's.
    const others =
      [...runs.values()].some((r) => going(r) && !ours.has(String(r.id))) || [...subagents.values()].some((t) => working(t) && !ours.has(String(t.runId)));
    if (others) {
      for (const r of [...runs.values()].filter((r) => going(r) && r.status !== "queued" && ours.has(String(r.id))))
        await command({ type: "run.interrupt", commandId: `top:stop:${String(r.id)}`, threadId, runId: String(r.id) });
      for (const t of [...subagents.values()].filter((t) => working(t) && ours.has(String(t.runId)))) {
        const stopTask = command({
          type: "subagent.stop",
          commandId: `top:stop-task:${String(t.id)}`,
          threadId,
          runId: String(t.runId),
          subagentId: String(t.id),
        });
        // A task with a thread of its own is stopped there (its parent's stop may not reach it), but only its own runs:
        // T3 Code reuses a child's thread for follow-ups, and someone else's may be going or queued in it too.
        if (t.origin === "app_owned" && str(t.childThreadId)) {
          await stopTask.catch(() => {});
          const child = str(t.childThreadId)!;
          const childRuns = (await readThread(cfg.url, cfg.token, child)).runs;
          for (const r of (Array.isArray(childRuns) ? childRuns : []).map(record)) {
            if (r.delegatedTaskId !== t.id || TERMINAL_RUN.has(String(r.status))) continue;
            const queued = r.status === "queued";
            await command({
              type: queued ? "queued-run.cancel" : "run.interrupt",
              commandId: `top:${queued ? "unqueue" : "stop"}:${String(r.id)}`,
              threadId: child,
              runId: String(r.id),
            });
          }
        } else await stopTask;
      }
      emit({ type: "log", kind: "status", text: "Someone else's work is going in the thread, so Top stopped only its own runs and tasks there." });
    } else await command({ type: "thread.stop", commandId: `top:stop-thread:${turn.key}`, threadId, reason: "Cancelled from Top." });
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
    } else if (str(own.startedAt) === undefined) {
      // Removed from T3 Code's queue before it ran: its own end, whatever else the thread does.
    } else if (own.status !== "rolled_back") {
      // A run Top adopted waits only on its own work; a turn of a task, on the whole thread's, as T3 Code settles it.
      const { working, delegated } = delegatedWork(turn.adopted ? new Set(ours.map((r) => String(r.id))) : undefined);
      if (working || delegated) {
        if (!turn.holding && delegated) {
          turn.holding = true;
          emit({ type: "held" });
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
      // The turn's runs by when they ran: T3 Code may run a queued one with a lower number after this turn's.
      outcome = ours.filter((r) => ended(r) && r.status !== "rolled_back" && r.startedAt != null).reduce((a, b) => (ranAfter(b, a) ? b : a), own);
    }
    turn.done = true;
    turn.covered = coverage(turn);
    const answerable = ours.includes(outcome);
    if (!answerable) emit({ type: "log", kind: "status", text: "Someone wrote into this run in T3 Code, so its answer stays there." });
    const its = answerable ? [...items.values()].filter((i) => i.runId === outcome.id).sort((a, b) => Number(a.ordinal ?? 0) - Number(b.ordinal ?? 0)) : [];
    // Stop in T3 Code while it held (or while Top was away): T3 Code records the stop after the answer's run ended, on
    // whichever run it targets, and cancels the work.
    const answeredAt = Date.parse(str(outcome.completedAt) ?? "");
    // Only a stop on this turn's runs, or on a monitor's run going then: someone stopping their own run isn't this turn's.
    const stoppable = new Set([...ours.map((r) => String(r.id)), ...monitorRuns]);
    const stoppedThere =
      !turn.cut &&
      [...items.values()].some(
        (i) => i.type === "run_interrupt_request" && stoppable.has(String(i.runId)) && Date.parse(str(i.updatedAt) ?? str(i.startedAt) ?? "") >= answeredAt,
      );
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
      messages.clear();
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
        joined: new Set(),
        known: new Set(turn.known ?? []),
        cancelled: new Set(turn.cancelled ?? []),
        accounted: new Map(turn.accounted ?? []),
        adopted: turn.adopt !== undefined,
        covered: undefined,
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
      if (turn.adopt) {
        // A run T3 Code started on its own: follow it as this turn, sending nothing.
        mine.runId = turn.adopt;
        await followed();
        evaluate();
        return;
      }
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
    // What a turn reported is only what it had when it ended: a turn cut off before that (T3 Code out of reach, a cancel
    // it never saw through) reported none of its runs, so they stay to be reported.
    covered: () => (current ? (current.covered ?? { runs: [], earlier: coverage(current).earlier }) : { runs: [], earlier: [] }),
  };
}
