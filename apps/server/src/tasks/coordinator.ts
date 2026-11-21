import { randomBytes } from "node:crypto";
import { mkdir, realpath, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { MAX_TASK_ANSWER, type TaskAnswers, TaskError, type TaskInputView, type TaskState, taskEnded, type WaitingTask } from "@top/protocol";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import Value from "typebox/value";
import type { InboxRow } from "../store.ts";
import { duration } from "../time.ts";
import { stopped } from "../tools.ts";
import {
  clip,
  follows,
  type HarnessAdapter,
  type HarnessAnswer,
  type HarnessEvent,
  type HarnessSession,
  HarnessUnavailable,
  inCloud,
  redact,
  type SessionWatch,
  type Turn,
  type Usage,
  type WatchedThread,
} from "./harness.ts";
import {
  ACTIVE_STATES,
  type NewEvent,
  type RunAccount,
  type SessionRow,
  type TaskEventKind,
  type TaskEventRow,
  type TaskInputRow,
  type TaskMessageRow,
  type TaskQueries,
  type TaskRow,
} from "./store.ts";

export const MAX_PROMPT = 100_000;
export const MAX_TITLE = 120;
export const MAX_IMAGES = 10;
export const RESULT_CHARS = 30_000;
export const EVENT_CHARS = 2_000;
export const MAX_EVENTS = 1_000;
export const MAX_READ = 200;
export const DEFAULT_READ = 50;
export const READ_CHARS = 24_000;
export const MAX_ACTIVE_PER_BOT = 12;
export const NOTIFY_RESULT_CHARS = 4_000;
const FLUSH_MS = 250;
const PUBLISH_MS = 100;
const STEER_TIMEOUT_MS = 30_000;
const STEER_TOO_LATE = "The task ended before the harness took the message.";
const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp"];

export type TasksConfig = {
  readonly adapters: readonly HarnessAdapter[];
  readonly maxRunning?: number | undefined;
  readonly folder?: ((bot: number) => Effect.Effect<string | undefined>) | undefined;
  readonly cancelGraceMs?: number | undefined;
  readonly hide?: ((text: string) => string) | undefined;
};

export type TasksEvents = {
  readonly deliver: (row: InboxRow) => Effect.Effect<void>;
  /** The tasks waiting for an answer, whenever that set changes: the app hears nothing else of a task. */
  readonly publish: (waiting: readonly WaitingTask[]) => Effect.Effect<void>;
};

export type StartRequest = {
  readonly bot: number;
  readonly key: string;
  readonly harness?: string | undefined;
  readonly prompt: string;
  readonly title?: string | undefined;
  readonly cwd?: string | undefined;
  readonly session?: string | undefined;
  readonly fork?: boolean | undefined;
  readonly model?: string | undefined;
  readonly options?: Readonly<Record<string, unknown>> | undefined;
  readonly images?: readonly string[] | undefined;
};

export type TaskAnswer = { readonly answers: TaskAnswers };

export type Snapshot = {
  readonly task: TaskRow;
  readonly session: SessionRow;
  readonly inputs: readonly TaskInputRow[];
  readonly queued: number;
  readonly capabilities: HarnessAdapter["capabilities"] | undefined;
};

export type ReadResult = Snapshot & { readonly events: readonly TaskEventRow[]; readonly more: boolean; readonly pruned: boolean; readonly cursor: number };

export type Tasks = {
  readonly adapters: readonly HarnessAdapter[];
  readonly start: (request: StartRequest) => Effect.Effect<{ readonly snapshot: Snapshot; readonly created: boolean }, TaskError>;
  readonly read: (bot: number, id: string, after: number, limit: number) => Effect.Effect<ReadResult, TaskError>;
  readonly snapshot: (bot: number | undefined, id: string) => Effect.Effect<Snapshot, TaskError>;
  readonly send: (
    bot: number,
    id: string,
    key: string,
    mode: "steer" | "queue",
    text: string,
  ) => Effect.Effect<{ readonly message: TaskMessageRow; readonly duplicate: boolean }, TaskError>;
  readonly respond: (by: "bot" | "user", bot: number | undefined, id: string, input: number, answer: TaskAnswer) => Effect.Effect<TaskInputRow, TaskError>;
  readonly wait: (
    bot: number,
    id: string,
    ms: number,
    until: "input_or_end" | "end",
    signal?: AbortSignal,
  ) => Effect.Effect<{ readonly snapshot: Snapshot; readonly timedOut: boolean }, TaskError>;
  readonly cancel: (bot: number | undefined, id: string) => Effect.Effect<{ readonly task: TaskRow; readonly cancelled: boolean }, TaskError>;
  readonly sessions: (bot: number) => Effect.Effect<readonly SessionRow[]>;
  /** The tasks waiting for an answer, as clients were last told. */
  readonly waiting: Effect.Effect<readonly WaitingTask[]>;
  /**
   * Stops the bot's tasks (its Stop button). `forget` (the bot is being deleted): a task its harness can't stop, in its vendor's
   * cloud, is let go instead, without a word to the vendor: Top stops following it and it ends `handed_off`.
   */
  readonly stopAll: (bot: number, forget?: boolean) => Effect.Effect<void>;
  readonly recover: Effect.Effect<number>;
};

type Signal =
  | { readonly type: "harness"; readonly event: HarnessEvent }
  | { readonly type: "answered"; readonly input: TaskInputRow; readonly answer: HarnessAnswer; readonly reply: AnswerWait | undefined }
  | { readonly type: "delivered"; readonly input: TaskInputRow; readonly why: string | undefined }
  | { readonly type: "steer"; readonly message: TaskMessageRow; readonly reply: Deferred.Deferred<string | undefined> }
  | { readonly type: "queued"; readonly message: TaskMessageRow }
  | { readonly type: "cancel" }
  | { readonly type: "cancel_timeout" }
  | { readonly type: "release"; readonly why: string };

/** Who waits to hear whether the harness took an answer: `task_respond` for a while, then nobody. */
type AnswerWait = { readonly reply: Deferred.Deferred<string | undefined>; listening: boolean };

type Live = {
  readonly id: string;
  readonly bot: number;
  row: TaskRow;
  session: SessionRow;
  readonly adapter: HarnessAdapter;
  readonly signals: Queue.Queue<Signal>;
  readonly lock: Semaphore.Semaphore;
  readonly done: Deferred.Deferred<void>;
  readonly cancelRequested: Deferred.Deferred<void>;
  fiber: Fiber.Fiber<void> | undefined;
  phase: "pending" | "started";
  readonly resumed: boolean;
  readonly cancelOnResume: boolean;
  /** Holds one of the execution slots: from when it starts until it ends, or only waits on work it delegated. */
  slot: boolean;
  harness: HarnessSession | undefined;
  turnActive: boolean;
  cancelling: boolean;
  stopping: boolean;
  closing: boolean;
  finished: boolean;
  waitersAny: number;
  waitersEnd: number;
  tick: Deferred.Deferred<void>;
  readonly inputs: Map<number, TaskInputRow>;
  readonly external: Map<string, number>;
  readonly steering: Set<Deferred.Deferred<string | undefined>>;
  /** Answers sent and not yet confirmed, by input; a resolution in the harness or the turn's end settles them too. */
  readonly answering: Map<number, { readonly external: string; readonly wait: AnswerWait | undefined }>;
  result: string | undefined;
  usage: Usage | undefined;
  events: number;
};

const fail = (message: string) => Effect.fail(new TaskError({ message }));
const newId = (prefix: string) => `${prefix}_${randomBytes(8).toString("base64url").replace(/[-_]/g, "x").slice(0, 10)}`;
const cloudCwd = (adapter: HarnessAdapter) =>
  `${adapter.label} runs in its vendor's cloud and takes no \`cwd\`: name what it works on in its options (${Object.keys(adapter.options.properties).join(", ")}).`;
const firstLine = (text: string) => clip(text.trim().split("\n")[0]?.trim() ?? "", 200);

const ENDED_AS: Record<string, string> = { completed: "completed", cancelled: "was cancelled", handed_off: "was handed off", failed: "failed" };

/** How a bot carries on with a session, said only where its harness can continue one and it got going there. */
export function carryOn(session: SessionRow, adapter: Pick<HarnessAdapter, "capabilities"> | undefined, lead = " "): string {
  if (!session.externalId || (adapter && !adapter.capabilities.resume)) return "";
  return `${lead}Its session ${session.id} is kept: to carry on, call collar__task_start with "session": "${session.id}".`;
}

export function notifyText(task: TaskRow, session: SessionRow, label: string, adapter?: Pick<HarnessAdapter, "capabilities">): string {
  const continues = task.continues ? `, continuing task ${task.continues}: ${label} went on with it on its own` : "";
  const head = `[Task ${task.id} ${ENDED_AS[task.state] ?? "failed"}] ${task.title} (${label}${continues})`;
  const ran = task.startedAt && task.endedAt ? `, after ${duration(task.endedAt - task.startedAt)}` : "";
  const answered = task.state === "completed" || task.state === "handed_off";
  const body = answered
    ? task.result
      ? clip(task.result, NOTIFY_RESULT_CHARS)
      : "(no answer text)"
    : (task.error ?? (task.state === "cancelled" ? "Cancelled." : "It failed."));
  const more = task.result && task.result.length > NOTIFY_RESULT_CHARS ? `\n\nThe whole answer is in collar__task_read {"id": "${task.id}"}.` : "";
  const resumable = !adapter || adapter.capabilities.resume;
  const next = resumable ? `\n\nIts session is ${session.id}: to carry on with it, call collar__task_start with "session": "${session.id}".` : "";
  return `${head}${ran}\n\n${body}${more}${next}`;
}

export const makeTasks = Effect.fnUntraced(function* (q: TaskQueries, config: TasksConfig, events: TasksEvents) {
  const scrub = (text: string) => redact(config.hide ? config.hide(text) : text);
  const scope = yield* Effect.scope;
  const adapters = new Map(config.adapters.map((a) => [a.id, a]));
  const slots = yield* Semaphore.make(config.maxRunning ?? 4);
  const starting = yield* Semaphore.make(1);
  const flushing = yield* Semaphore.make(1);
  const cancelGraceMs = config.cancelGraceMs ?? 10_000;
  const lives = new Map<string, Live>();
  const watches = new Map<string, SessionWatch>();
  /** Sessions a look is under way for, and whether another change came meanwhile. */
  const looking = new Map<string, boolean>();
  let buffer: NewEvent[] = [];
  const dirty = yield* Queue.sliding<void>(1);
  // What clients were last sent: a connecting client starts from it, so every later broadcast is a change to what it has.
  let published: readonly WaitingTask[] = [];
  let publishedJson = "[]";
  const now = Clock.currentTimeMillis;

  const label = (harness: string) => adapters.get(harness)?.label ?? harness;

  const flush = flushing.withPermits(1)(
    Effect.gen(function* () {
      if (!buffer.length) return;
      const batch = buffer;
      buffer = [];
      const saved = yield* Effect.exit(q.appendEvents(batch));
      if (Exit.isFailure(saved)) return yield* Effect.logWarning("Couldn't save harness task events", saved.cause);
      const counts = new Map<string, number>();
      for (const e of batch) counts.set(e.task, (counts.get(e.task) ?? 0) + 1);
      for (const [task, n] of counts) {
        const live = lives.get(task);
        if (!live) continue;
        live.events += n;
        if (live.events > MAX_EVENTS + 100) {
          yield* q.pruneEvents(task, MAX_EVENTS);
          live.events = MAX_EVENTS;
        }
      }
    }),
  );

  const log = (live: Live, kind: TaskEventKind, text: string) =>
    Effect.map(now, (at) => {
      const clipped = clip(scrub(text.trim()), EVENT_CHARS);
      if (!clipped) return;
      buffer.push({ task: live.id, bot: live.bot, at, kind, text: clipped });
    });

  const inputView = (row: TaskInputRow): TaskInputView => ({ id: row.id, title: row.title, questions: [...row.questions] });

  const waitingNow: Effect.Effect<readonly WaitingTask[]> = Effect.gen(function* () {
    const byTask = new Map<string, TaskInputView[]>();
    for (const input of yield* q.pendingInputs) byTask.set(input.task, [...(byTask.get(input.task) ?? []), inputView(input)]);
    const result: WaitingTask[] = [];
    for (const [id, inputs] of byTask) {
      const row = yield* q.task(id);
      if (row) result.push({ id, bot: row.bot, title: row.title, inputs });
    }
    return result;
  });

  const changed = (live: Live) =>
    Effect.gen(function* () {
      const tick = live.tick;
      live.tick = yield* Deferred.make<void>();
      Deferred.doneUnsafe(tick, Effect.void);
      yield* Queue.offer(dirty, undefined);
    });

  const setState = (live: Live, from: readonly TaskState[], to: TaskState) =>
    Effect.gen(function* () {
      const row = yield* q.setState(live.id, from, to);
      if (!row) return false;
      live.row = row;
      yield* log(live, "state", to);
      yield* changed(live);
      return true;
    });

  const snapshotOf = (row: TaskRow) =>
    Effect.gen(function* () {
      const session = (yield* q.session(row.session))!;
      const inputs = (yield* q.inputsOf(row.id)).filter((i) => i.state === "pending");
      const queued = (yield* q.pendingMessages(row.id)).filter((m) => m.mode === "queue").length;
      return { task: row, session, inputs, queued, capabilities: adapters.get(session.harness)?.capabilities } satisfies Snapshot;
    });

  const owned = (bot: number | undefined, id: string) =>
    Effect.gen(function* () {
      const row = yield* q.task(id.trim());
      if (!row || (bot !== undefined && row.bot !== bot))
        return yield* fail(`You have no task ${JSON.stringify(id)}. Your tasks are listed in collar__task_read without an id.`);
      return row;
    });

  const notify = (live: Live, key: string, text: string, suppressed: boolean) =>
    Effect.gen(function* () {
      const row = yield* q.notify(live.id, key, suppressed ? undefined : text);
      if (row) yield* events.deliver(row);
    });

  const finish = (
    live: Live,
    state: "completed" | "failed" | "cancelled" | "handed_off",
    end: { result?: string | undefined; error?: string | undefined } = {},
  ) =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        if (live.finished) return;
        live.finished = true;
        live.closing = true;
        for (const input of live.inputs.values()) if (input.external) live.harness?.answer(input.external, { kind: "cancelled" });
        live.inputs.clear();
        yield* q.withdrawInputs(live.id);
        const dropped = yield* live.lock.withPermits(1)(
          Effect.gen(function* () {
            const count = yield* q.dropMessages(live.id);
            for (const reply of live.steering) Deferred.doneUnsafe(reply, Effect.succeed(STEER_TOO_LATE));
            live.steering.clear();
            settleAnswers(live, "The task ended before the harness confirmed the answer.");
            return count;
          }),
        );
        const kept = end.result ?? live.result;
        const result = kept === undefined ? undefined : scrub(kept);
        const said = end.error === undefined ? undefined : scrub(end.error);
        const error = said && dropped ? `${said}\n(${dropped} queued message${dropped === 1 ? " was" : "s were"} not sent.)` : said;
        // The runs it reported, so no later task reports them again; on a session Top accounts for the first time, also
        // the runs that had ended before it, which nobody will.
        const accounts = yield* coveredAccounts(live);
        // A continuation that failed before it reported its run (T3 Code out of reach for too long) gives the run back,
        // so the watch adopts it again once T3 Code is back.
        const adopted = live.row.adopt;
        const release = adopted && state === "failed" && !accounts.some((a) => a.run === adopted) ? adopted : undefined;
        const row = yield* q.endTask(
          live.id,
          ACTIVE_STATES,
          state,
          {
            ...(result !== undefined ? { result: clip(result, RESULT_CHARS) } : {}),
            ...(error !== undefined ? { error: clip(error, 4_000) } : {}),
          },
          { session: live.session.id, bot: live.bot, runs: accounts, baselined: accounts.some((a) => a.kind === "baseline"), ...(release ? { release } : {}) },
        );
        if (live.usage) yield* q.setUsage(live.id, live.usage);
        if (row) live.row = row;
        yield* log(live, "state", state + (error ? `: ${error}` : ""));
        yield* flush;
        lives.delete(live.id);
        const suppressed = live.waitersAny + live.waitersEnd > 0;
        if (row) yield* notify(live, row.state, notifyText(row, live.session, label(live.session.harness), live.adapter), suppressed);
        yield* changed(live);
        yield* Deferred.succeed(live.done, undefined);
        yield* freeSlot(live);
        // What the harness does in the session from here on is the watch's to report.
        if (watches.has(live.adapter.id)) yield* Effect.forkIn(look(live.session.id), scope);
      }),
    );

  /** The runs a turn of the task reported, as accounts; for a session Top accounts for the first time, also the earlier ones. */
  const coveredAccounts = (live: Live) =>
    Effect.gen(function* () {
      const covered = live.harness?.covered?.();
      const accounts: RunAccount[] = [];
      if (!covered) return accounts;
      if (!(yield* q.session(live.session.id))?.baselined) for (const run of covered.earlier) accounts.push({ run, task: null, kind: "baseline" });
      for (const run of covered.runs) accounts.push({ run, task: live.id, kind: "reported" });
      return accounts;
    });

  /** A slot again for a task that gave its own back while it held, before it runs anything more here; a cancel wins the wait. */
  const takeSlot = (live: Live) =>
    Effect.gen(function* () {
      if (live.slot || inCloud(live.adapter)) return true;
      const got = yield* Effect.raceFirst(
        Effect.uninterruptibleMask((restore) =>
          Effect.as(
            Effect.tap(restore(slots.take(1)), () => Effect.sync(() => (live.slot = true))),
            true,
          ),
        ),
        Effect.as(Deferred.await(live.cancelRequested), false),
      );
      return got;
    });

  const freeSlot = (live: Live) =>
    Effect.suspend(() => {
      if (!live.slot) return Effect.void;
      live.slot = false;
      return Effect.asVoid(slots.release(1));
    });

  const emitTo = (live: Live) => (event: HarnessEvent) => {
    Queue.offerUnsafe(live.signals, { type: "harness", event });
  };

  const queuedTurn = (live: Live, message: TaskMessageRow): Turn => ({ key: `${live.id}:m${message.id}`, text: message.text, images: [] });

  const runTurn = (live: Live, given: Turn) =>
    Effect.gen(function* () {
      const harness = live.harness!;
      // A watched harness's turn leaves out work the session's cancelled tasks caused.
      const turn: Turn = watches.has(live.adapter.id) ? { ...given, cancelled: yield* q.cancelledTasksOf(live.session.id) } : given;
      live.turnActive = true;
      const ran = yield* Effect.raceFirst(
        Effect.result(Effect.tryPromise(() => harness.run(turn))),
        Effect.as(Deferred.await(live.cancelRequested), "cancelled" as const),
      );
      if (ran === "cancelled") return true;
      if (ran._tag === "Failure") {
        live.turnActive = false;
        const cause = ran.failure.cause;
        yield* finish(live, "failed", {
          error: `${label(live.session.harness)} didn't take the message: ${cause instanceof Error ? cause.message : String(cause)}`,
        });
        return false;
      }
      return true;
    });

  const settleAnswers = (live: Live, outcome: string | undefined) => {
    for (const { wait } of live.answering.values()) if (wait) Deferred.doneUnsafe(wait.reply, Effect.succeed(outcome));
    live.answering.clear();
  };

  const cancelInputs = (live: Live) =>
    Effect.gen(function* () {
      for (const input of live.inputs.values()) if (input.external) live.harness?.answer(input.external, { kind: "cancelled" });
      live.inputs.clear();
      live.external.clear();
      yield* q.withdrawInputs(live.id);
      yield* Queue.offer(dirty, undefined);
    });

  const afterInput = (live: Live) =>
    live.inputs.size === 0 && live.row.state === "waiting_for_input" ? setState(live, ["waiting_for_input"], "running") : Effect.succeed(true);

  /** Sends an answer; whether the harness took it comes back as a `delivered` signal. */
  const deliver = (live: Live, input: TaskInputRow, external: string, answer: HarnessAnswer, wait: AnswerWait | undefined) =>
    Effect.gen(function* () {
      live.answering.set(input.id, { external, wait });
      const sent = live.harness?.answer(external, answer);
      if (!sent) {
        Queue.offerUnsafe(live.signals, { type: "delivered", input, why: undefined });
        return;
      }
      yield* Effect.forkIn(
        Effect.gen(function* () {
          const done = yield* Effect.result(Effect.tryPromise(() => sent));
          const cause = done._tag === "Failure" ? done.failure.cause : undefined;
          Queue.offerUnsafe(live.signals, {
            type: "delivered",
            input,
            why: done._tag === "Success" ? undefined : cause instanceof Error ? cause.message : String(cause),
          });
        }),
        scope,
      );
    });

  const handle = (live: Live, signal: Signal): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (live.finished) {
        if (signal.type === "harness" && signal.event.type === "session") signal.event.saved?.(new Error("The task has ended."));
        if (signal.type === "steer") yield* Deferred.succeed(signal.reply, "The task has ended.");
        if (signal.type === "answered" && signal.reply) yield* Deferred.succeed(signal.reply.reply, "The task has ended.");
        return;
      }
      switch (signal.type) {
        case "harness": {
          const event = signal.event;
          switch (event.type) {
            case "session": {
              const saved = live.session.externalId === event.externalId ? Exit.void : yield* Effect.exit(q.setExternalId(live.session.id, event.externalId));
              if (Exit.isSuccess(saved)) live.session = { ...live.session, externalId: event.externalId };
              event.saved?.(Exit.isSuccess(saved) ? undefined : new Error("Top couldn't save the session's id."));
              if (Exit.isFailure(saved)) return yield* Effect.failCause(saved.cause);
              return;
            }
            case "log":
              yield* log(live, event.kind, event.text);
              return;
            case "usage":
              live.usage = event.usage;
              return;
            case "held":
              yield* log(live, "status", "only waiting on work it delegated: its execution slot is free for other tasks meanwhile");
              yield* freeSlot(live);
              return;
            case "request": {
              const request = event.request;
              if (live.cancelling) {
                live.harness?.answer(request.id, { kind: "cancelled" });
                return;
              }
              const title = clip(scrub(request.title), 400);
              const questions = request.questions.map((question) => ({
                ...question,
                question: scrub(question.question),
                ...(question.header === undefined ? {} : { header: scrub(question.header) }),
                options: question.options
                  .filter((option) => scrub(option.label) === option.label)
                  .map((option) => ({
                    ...option,
                    ...(option.description === undefined ? {} : { description: scrub(option.description) }),
                  })),
              }));
              const { input } = yield* q.addInput({ task: live.id, bot: live.bot, external: request.id, title, questions });
              // Followed again after a restart: an answer Top saved may not have reached the harness, which asks again.
              if (live.resumed && input.state === "answered" && input.answer) {
                yield* deliver(live, input, request.id, { kind: "question", answers: (input.answer as TaskAnswer).answers }, undefined);
                return;
              }
              if (input.state !== "pending") return;
              live.inputs.set(input.id, input);
              live.external.set(request.id, input.id);
              yield* log(live, "input", `asks: ${request.title} (request ${input.id})`);
              const suppressed = live.waitersAny > 0;
              if (live.row.state !== "waiting_for_input") yield* setState(live, ["running", "starting"], "waiting_for_input");
              else yield* changed(live);
              yield* notify(
                live,
                `input:${input.id}`,
                [
                  `[Task ${live.id} needs input] ${live.row.title} (${label(live.session.harness)}) asks: ${title}`,
                  ...questions.map(
                    (q) => `- ${q.id}: ${q.question}${q.options.length ? ` Options: ${q.options.map((o) => JSON.stringify(o.label)).join(", ")}` : ""}`,
                  ),
                  "",
                  `Answer with collar__task_respond {"id": "${live.id}", "request": ${input.id}, "answers": {…}}, or leave it to the user, who sees it on a card.`,
                ].join("\n"),
                suppressed,
              );
              return;
            }
            case "resolved": {
              const id = live.external.get(event.id);
              if (id === undefined) {
                // Settled in the harness while Top's answer to it was on its way: nothing to reopen if that answer is refused.
                for (const [input, sending] of live.answering)
                  if (sending.external === event.id) {
                    live.answering.delete(input);
                    if (sending.wait) yield* Deferred.succeed(sending.wait.reply, undefined);
                  }
                return;
              }
              live.external.delete(event.id);
              live.inputs.delete(id);
              const withdrawn = yield* q.withdrawInput(id);
              if (withdrawn) yield* log(live, "input", `request ${id} was withdrawn by ${label(live.session.harness)}`);
              if (!(yield* afterInput(live))) return;
              yield* changed(live);
              return;
            }
            case "turn_ended": {
              live.turnActive = false;
              settleAnswers(live, undefined);
              if (live.inputs.size) yield* cancelInputs(live);
              if (event.status === "completed") {
                live.result = event.result ?? live.result;
                // The runs this turn reported are accounted for before the next one replaces it.
                const accounts = yield* coveredAccounts(live);
                if (accounts.length)
                  yield* q.accountRuns(
                    live.session.id,
                    live.bot,
                    accounts,
                    accounts.some((a) => a.kind === "baseline"),
                  );
                // A queued message runs on a slot: one it gave back while it held is taken again first, outside the lock,
                // and the message stays pending until then.
                let next: TaskMessageRow | undefined;
                for (;;) {
                  const picked = yield* live.lock.withPermits(1)(
                    Effect.gen(function* () {
                      if (!live.cancelling) {
                        const pending = (yield* q.pendingMessages(live.id)).filter((m) => m.mode === "queue");
                        if (pending.length && !live.slot && !inCloud(live.adapter)) return "slot" as const;
                        for (const candidate of pending) if (yield* q.setMessageState(candidate.id, "sent")) return candidate;
                      }
                      live.closing = true;
                      return undefined;
                    }),
                  );
                  if (picked !== "slot") {
                    next = picked;
                    break;
                  }
                  if (!(yield* takeSlot(live))) return yield* finish(live, "cancelled");
                }
                if (!next) return yield* finish(live, "completed", { result: live.result ?? "" });
                yield* log(live, "sent", `queued message ${next.id} started a new turn`);
                if (live.row.state === "waiting_for_input") yield* setState(live, ["waiting_for_input"], "running");
                yield* runTurn(live, queuedTurn(live, next));
                return;
              }
              if (event.status === "handed_off") return yield* finish(live, "handed_off", { result: event.result ?? live.result ?? "" });
              if (live.cancelling) return yield* finish(live, "cancelled");
              if (event.status === "interrupted")
                return yield* finish(live, "failed", { error: event.error ?? `${label(live.session.harness)} stopped the turn before it finished.` });
              return yield* finish(live, "failed", { error: event.error ?? "The turn failed." });
            }
            case "exited": {
              if (live.cancelling) return yield* finish(live, "cancelled");
              return yield* finish(live, "failed", { error: `${event.error}.${carryOn(live.session, live.adapter)}` });
            }
          }
          return;
        }
        case "answered": {
          const { input, answer, reply } = signal;
          live.inputs.delete(input.id);
          if (input.external && !live.external.has(input.external)) {
            // The harness settled the request before this answer reached it: nothing to send.
            yield* log(
              live,
              "answer",
              `request ${input.id}: answered by the ${input.answeredBy ?? "user"} after ${label(live.session.harness)} had settled it`,
            );
            if (reply) yield* Deferred.succeed(reply.reply, `${label(live.session.harness)} had already settled request ${input.id}; the answer wasn't sent.`);
            return;
          }
          if (input.external) {
            live.external.delete(input.external);
            yield* deliver(live, input, input.external, answer, reply);
          } else if (reply) yield* Deferred.succeed(reply.reply, undefined);
          yield* log(live, "answer", `request ${input.id}: answered by the ${input.answeredBy ?? "user"}`);
          if (yield* afterInput(live)) yield* changed(live);
          return;
        }
        case "delivered": {
          const { input, why } = signal;
          const sending = live.answering.get(input.id);
          // Already settled: resolved in the harness meanwhile, or the turn ended. Nothing to reopen.
          if (!sending) return;
          live.answering.delete(input.id);
          if (why === undefined) {
            if (sending.wait) yield* Deferred.succeed(sending.wait.reply, undefined);
            return;
          }
          const said = `${label(live.session.harness)} didn't take the answer to request ${input.id}: ${clip(scrub(why), 400).replace(/\.$/, "")}`;
          const reopened = yield* q.reopenInput(input.id);
          if (reopened) {
            live.inputs.set(reopened.id, reopened);
            if (reopened.external) live.external.set(reopened.external, reopened.id);
            yield* log(live, "answer", `${said}. It waits for an answer again.`);
            if (live.row.state === "running") yield* setState(live, ["running"], "waiting_for_input");
            else yield* changed(live);
            // The bot answered, and its task_respond stopped waiting: it hears now.
            if (input.answeredBy === "bot" && !sending.wait?.listening)
              yield* notify(
                live,
                `reopened:${input.id}:${input.answeredAt ?? 0}`,
                `[Task ${live.id}] ${said}. Request ${input.id} is waiting again: answer it with collar__task_respond.`,
                false,
              );
          }
          if (sending.wait) yield* Deferred.succeed(sending.wait.reply, `${said}. The request is waiting again: answer it again.`);
          return;
        }
        case "steer": {
          if (live.cancelling || !live.turnActive || !live.harness) {
            yield* q.setMessageState(signal.message.id, "dropped");
            live.steering.delete(signal.reply);
            yield* Deferred.succeed(signal.reply, `No turn is running to steer (the task is ${live.row.state}). Send it with mode "queue" instead.`);
            return;
          }
          const harness = live.harness;
          const { message, reply } = signal;
          yield* Effect.forkIn(
            Effect.gen(function* () {
              const sent = yield* Effect.result(Effect.tryPromise(() => harness.steer(message.text)));
              if (sent._tag === "Failure") {
                yield* q.setMessageState(message.id, "dropped");
                const cause = sent.failure.cause;
                yield* Deferred.succeed(reply, cause instanceof Error ? cause.message : String(cause));
                return;
              }
              yield* live.lock.withPermits(1)(
                Effect.gen(function* () {
                  if (yield* q.setMessageState(message.id, "sent")) {
                    yield* log(live, "sent", `steered with message ${message.id}: ${firstLine(message.text)}`);
                    yield* Deferred.succeed(reply, undefined);
                  } else yield* Deferred.succeed(reply, STEER_TOO_LATE);
                }),
              );
            }).pipe(Effect.ensuring(Effect.sync(() => live.steering.delete(reply)))),
            scope,
          );
          return;
        }
        case "queued":
          yield* log(live, "sent", `queued message ${signal.message.id}: ${firstLine(signal.message.text)}`);
          if (!live.turnActive && live.harness && !live.cancelling && live.row.state === "running") {
            if (!(yield* takeSlot(live))) return yield* finish(live, "cancelled");
            if (!live.cancelling && (yield* q.setMessageState(signal.message.id, "sent"))) yield* runTurn(live, queuedTurn(live, signal.message));
          }
          return;
        case "cancel": {
          if (live.stopping) return;
          live.stopping = true;
          live.cancelling = true;
          yield* cancelInputs(live);
          if (!live.turnActive || !live.harness) return yield* finish(live, "cancelled");
          const harness = live.harness;
          yield* log(live, "status", "cancelling: stopping the turn");
          // The grace for confirming the stop starts once it was sent. A durable harness may first have to find the turn, and
          // bounds that itself; a local one gets a bound here, so a stop that hangs still ends the task.
          const sendingStop = Effect.promise(() => harness.interrupt().catch(() => {}));
          yield* Effect.forkIn(
            (live.adapter.capabilities.durable ? sendingStop : sendingStop.pipe(Effect.timeout(Duration.millis(cancelGraceMs * 2)))).pipe(
              Effect.ignore,
              Effect.andThen(Effect.sleep(Duration.millis(cancelGraceMs))),
              Effect.andThen(Effect.sync(() => Queue.offerUnsafe(live.signals, { type: "cancel_timeout" }))),
            ),
            scope,
          );
          return;
        }
        case "release":
          if (live.stopping) return;
          live.stopping = true;
          yield* cancelInputs(live);
          return yield* finish(live, "handed_off", { result: signal.why });
        case "cancel_timeout":
          return yield* finish(
            live,
            "cancelled",
            live.adapter.capabilities.durable
              ? { error: `${label(live.session.harness)} didn't confirm the stop within ${cancelGraceMs / 1000} s; it may still be running there.` }
              : {},
          );
      }
    });

  const closeHarness = (live: Live) =>
    Effect.suspend(() => {
      const harness = live.harness;
      live.harness = undefined;
      if (!harness) return Effect.void;
      return Effect.promise(() => harness.close().catch(() => {})).pipe(Effect.timeout(Duration.seconds(15)), Effect.ignore);
    });

  const specOf = (live: Live) =>
    Effect.gen(function* () {
      const session = live.session;
      let resume = session.externalId ?? undefined;
      let fork = false;
      if (!resume && session.parent) {
        const parent = yield* q.session(session.parent);
        if (parent?.externalId) {
          resume = parent.externalId;
          fork = true;
        }
      }
      return { session: session.id, title: live.row.title, cwd: session.cwd, model: session.model ?? undefined, options: session.options, resume, fork };
    });

  const runStarted = (live: Live) =>
    Effect.gen(function* () {
      const begun = yield* live.lock.withPermits(1)(
        Effect.gen(function* () {
          if (live.cancelling && !live.resumed) return false;
          if (!live.resumed && !(yield* setState(live, ["queued"], "starting"))) return false;
          live.phase = "started";
          return true;
        }),
      );
      if (!begun) return;
      const adapter = live.adapter;
      // Followed again after a restart, a durable harness reconnects within its own window instead of failing on one look.
      // A recovered task isn't stopped from here: even when cancelled, it goes on to stop the harness's turn below.
      const available = live.resumed
        ? { ok: true as const, version: "" }
        : yield* Effect.raceFirst(
            Effect.promise(() => adapter.check().catch((error: unknown) => ({ ok: false as const, error: String(error) }))),
            Effect.as(Deferred.await(live.cancelRequested), "cancelled" as const),
          );
      if (available === "cancelled") return yield* finish(live, "cancelled");
      if (!available.ok) return yield* finish(live, "failed", { error: available.error });
      if (available.version) yield* log(live, "status", `${adapter.label} ${available.version}`);
      if (live.cancelling && !live.resumed) return yield* finish(live, "cancelled");
      const spec = yield* specOf(live);
      const opening = adapter.open(spec, emitTo(live));
      const open = Effect.tryPromise(() => opening).pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            opening.then(
              (late) => late.close(),
              () => {},
            );
          }),
        ),
        Effect.result,
      );
      const opened = live.resumed ? yield* open : yield* Effect.raceFirst(open, Effect.as(Deferred.await(live.cancelRequested), "cancelled" as const));
      if (opened === "cancelled") return yield* finish(live, "cancelled");
      if (opened._tag === "Failure") {
        const cause = opened.failure.cause;
        const message =
          cause instanceof HarnessUnavailable ? cause.message : `${adapter.label} didn't start: ${cause instanceof Error ? cause.message : String(cause)}`;
        return yield* finish(live, "failed", { error: message });
      }
      live.harness = opened.success;
      if (live.cancelling && !live.resumed) return yield* finish(live, "cancelled");
      if ((!live.resumed || live.row.state === "starting") && !(yield* setState(live, ["starting"], "running"))) return yield* finish(live, "cancelled");
      // Its answer was saved but the restart came before the task went back to work: the harness asks again if it still waits.
      if (live.resumed && live.row.state === "waiting_for_input" && live.inputs.size === 0) yield* setState(live, ["waiting_for_input"], "running");
      if (live.cancelling && !live.resumed) return yield* finish(live, "cancelled");
      // A durable harness that Top follows again after a restart gets the turn it was on, with the same key, so it takes it once.
      const sent = live.resumed ? yield* q.lastSentQueued(live.id) : undefined;
      if (live.resumed && !live.row.adopt) yield* log(live, "status", `following it again after Top restarted`);
      const turn: Turn = sent
        ? queuedTurn(live, sent)
        : live.row.adopt
          ? { key: live.id, text: "", images: [], adopt: live.row.adopt, known: [...(yield* q.runsOf(live.session.id)).keys()] }
          : { key: live.id, text: live.row.prompt, images: live.row.images };
      // A cancel started before Top restarted, or since: stop the turn if the harness has it, and never send it.
      const stopping = live.resumed && (live.cancelOnResume || live.cancelling);
      if (stopping) {
        live.cancelling = true;
        yield* log(live, "status", "cancelled: stopping it in the harness");
      }
      if (!(yield* runTurn(live, stopping ? { ...turn, followOnly: true } : turn))) return;
      if (stopping) Queue.offerUnsafe(live.signals, { type: "cancel" });
      while (!live.finished) yield* handle(live, yield* Queue.take(live.signals));
    }).pipe(Effect.ensuring(closeHarness(live)));

  const actor = (live: Live) =>
    Effect.gen(function* () {
      // A cloud harness's work runs there, not here: following it holds none of this computer's running slots.
      if (!inCloud(live.adapter))
        yield* Effect.uninterruptibleMask((restore) => Effect.tap(restore(slots.take(1)), () => Effect.sync(() => (live.slot = true))));
      yield* runStarted(live).pipe(Effect.ensuring(freeSlot(live)));
      if (!live.finished) yield* finish(live, "failed", { error: "The task ended without an outcome." });
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.gen(function* () {
              yield* Effect.logError(`task ${live.id}`, cause);
              yield* closeHarness(live);
              yield* finish(live, "failed", {
                error: `Top failed while running it: ${Cause.squash(cause) instanceof Error ? (Cause.squash(cause) as Error).message : "unknown error"}`,
              });
            }),
      ),
    );

  const spawnLive = (row: TaskRow, session: SessionRow, adapter: HarnessAdapter, resumed = false, cancelOnResume = false) =>
    Effect.gen(function* () {
      const live: Live = {
        id: row.id,
        bot: row.bot,
        row,
        session,
        adapter,
        signals: yield* Queue.unbounded<Signal>(),
        lock: yield* Semaphore.make(1),
        done: yield* Deferred.make<void>(),
        cancelRequested: yield* Deferred.make<void>(),
        fiber: undefined,
        phase: "pending",
        resumed,
        cancelOnResume,
        slot: false,
        harness: undefined,
        turnActive: false,
        cancelling: false,
        stopping: false,
        closing: false,
        finished: false,
        waitersAny: 0,
        waitersEnd: 0,
        tick: yield* Deferred.make<void>(),
        inputs: new Map(),
        external: new Map(),
        steering: new Set(),
        answering: new Map(),
        result: undefined,
        usage: undefined,
        events: 0,
      };
      if (resumed)
        for (const input of yield* q.inputsOf(row.id))
          if (input.state === "pending") {
            live.inputs.set(input.id, input);
            if (input.external) live.external.set(input.external, input.id);
          }
      lives.set(row.id, live);
      live.fiber = yield* Effect.forkIn(actor(live), scope);
      return live;
    });

  const checkImages = (paths: readonly string[], base: string) =>
    Effect.gen(function* () {
      if (paths.length > MAX_IMAGES) return yield* fail(`Give at most ${MAX_IMAGES} images.`);
      const out: string[] = [];
      for (const raw of paths) {
        const path = resolve(base, raw);
        if (!IMAGE_EXTENSIONS.includes(extname(path).toLowerCase())) return yield* fail(`${raw} isn't a PNG, JPEG, GIF or WebP image.`);
        const info = yield* Effect.promise(() => stat(path).catch(() => undefined));
        if (!info?.isFile()) return yield* fail(`There's no image at ${path}.`);
        if (info.size > 10 * 1024 * 1024) return yield* fail(`${path} is over 10 MB.`);
        out.push(path);
      }
      return out;
    });

  const checkOptions = (adapter: HarnessAdapter, options: Readonly<Record<string, unknown>>) =>
    Effect.gen(function* () {
      if (Value.Check(adapter.options, options)) return options;
      const errors = [...Value.Errors(adapter.options, options)]
        .slice(0, 3)
        .map((e) => `${e.instancePath || "options"} ${e.message}`)
        .join("; ");
      const known = Object.keys(adapter.options.properties);
      return yield* fail(`Bad options for ${adapter.label}: ${errors}. ${adapter.label} takes ${known.length ? known.join(", ") : "no options"}.`);
    });

  const resolveCwd = (raw: string, bot: number) =>
    Effect.gen(function* () {
      const folder = config.folder ? yield* config.folder(bot) : undefined;
      const base = folder ?? process.cwd();
      const given = raw === "~" ? (process.env.HOME ?? "/") : raw.startsWith("~/") ? resolve(process.env.HOME ?? "/", raw.slice(2)) : resolve(base, raw);
      if (folder && given === resolve(folder)) yield* Effect.promise(() => mkdir(folder, { recursive: true }).catch(() => undefined));
      const real = yield* Effect.promise(() => realpath(given).catch(() => undefined));
      if (!real) return yield* fail(`There's no folder ${given}.`);
      const info = yield* Effect.promise(() => stat(real).catch(() => undefined));
      if (!info?.isDirectory()) return yield* fail(`${given} isn't a folder.`);
      return { cwd: real };
    });

  const locate = (
    adapter: HarnessAdapter & { locate: NonNullable<HarnessAdapter["locate"]> },
    raw: string | undefined,
    start: { readonly options: Readonly<Record<string, unknown>>; readonly model: string | undefined },
  ) =>
    Effect.tryPromise({
      try: () => adapter.locate(raw?.trim() || undefined, start),
      catch: (error) => new TaskError({ message: error instanceof Error ? error.message : String(error) }),
    });

  const start: Tasks["start"] = (request) =>
    starting.withPermits(1)(
      Effect.gen(function* () {
        const existing = yield* q.taskByKey(request.key);
        if (existing) return { snapshot: yield* snapshotOf(existing), created: false };
        const prompt = request.prompt.trim();
        if (!prompt) return yield* fail("Say what the task is in `prompt`.");
        if (prompt.length > MAX_PROMPT) return yield* fail(`Keep the prompt under ${MAX_PROMPT} characters; put long material in a file and point at it.`);
        const active = [...lives.values()].filter((l) => l.bot === request.bot).length;
        if (active >= MAX_ACTIVE_PER_BOT) return yield* fail(`You already have ${active} tasks running or waiting. Wait for some to end, or cancel some.`);

        let session: SessionRow;
        let adapter: HarnessAdapter | undefined;
        let images: string[] = [];
        const imagesFor = (harness: HarnessAdapter, cwd: string) =>
          Effect.gen(function* () {
            if (!request.images?.length) return [];
            if (!harness.capabilities.images) return yield* fail(`${harness.label} doesn't take images.`);
            return yield* checkImages(request.images, cwd);
          });
        if (request.session !== undefined) {
          const source = yield* q.session(request.session.trim());
          if (!source || source.bot !== request.bot) return yield* fail(`You have no session ${JSON.stringify(request.session)}.`);
          adapter = adapters.get(source.harness);
          if (!adapter) return yield* fail(`Session ${source.id} is ${source.harness}'s, which this daemon doesn't run.`);
          if (request.harness !== undefined && request.harness !== source.harness)
            return yield* fail(`Session ${source.id} is ${adapter.label}'s; leave out \`harness\` or use "${source.harness}".`);
          if (inCloud(adapter) && request.cwd !== undefined) return yield* fail(cloudCwd(adapter));
          if (request.cwd !== undefined) {
            const cwd = adapter.locate ? request.cwd.trim() : (yield* resolveCwd(request.cwd, request.bot)).cwd;
            if (cwd !== source.cwd) return yield* fail(`Session ${source.id} works in ${source.cwd}. Start a new session to work somewhere else.`);
          }
          if (request.fork) {
            if (!adapter.capabilities.fork) return yield* fail(`${adapter.label} can't branch a session.`);
            if (!source.externalId) return yield* fail(`Session ${source.id} never got going in ${adapter.label}, so there's nothing to branch from.`);
            const options = request.options ? yield* checkOptions(adapter, request.options) : source.options;
            images = yield* imagesFor(adapter, source.cwd);
            session = yield* q.createSession({
              id: newId("ses"),
              bot: request.bot,
              harness: source.harness,
              cwd: source.cwd,
              model: request.model ?? source.model,
              options,
              parent: source.id,
            });
          } else {
            if (!adapter.capabilities.resume) return yield* fail(`${adapter.label} can't continue a session.`);
            if (!source.externalId)
              return yield* fail(
                `Session ${source.id} never got going in ${adapter.label}, so there's nothing to continue. Start a new task without \`session\`.`,
              );
            if (request.model !== undefined && request.model !== source.model)
              return yield* fail(`Session ${source.id} uses ${source.model ?? "the default model"}. Branch it (fork: true) to switch models.`);
            if (request.options !== undefined) return yield* fail(`Session ${source.id} keeps its options; branch it (fork: true) to change them.`);
            const busy = yield* q.sessionBusy(source.id, "");
            const queued = [...lives.values()].find((l) => l.session.id === source.id);
            if (busy || queued)
              return yield* fail(
                `Session ${source.id} is busy with task ${busy ?? queued!.id}. Queue more work there with collar__task_send (mode "queue"), or wait for it to end.`,
              );
            images = yield* imagesFor(adapter, source.cwd);
            session = source;
          }
        } else {
          const harness = request.harness;
          if (harness === undefined) return yield* fail(`Say which harness runs it: ${[...adapters.keys()].map((h) => `"${h}"`).join(" or ")}.`);
          adapter = adapters.get(harness);
          if (!adapter)
            return yield* fail(`There's no harness "${harness}". This daemon runs ${[...adapters.keys()].map((h) => `"${h}"`).join(", ") || "none"}.`);
          if (request.fork) return yield* fail("`fork` branches an existing session: give it with `session`.");
          if (inCloud(adapter) && request.cwd !== undefined) return yield* fail(cloudCwd(adapter));
          const options = yield* checkOptions(adapter, request.options ?? {});
          const folder = adapter.locate || !config.folder ? undefined : yield* config.folder(request.bot);
          const raw = request.cwd ?? folder;
          if (raw === undefined && !adapter.locate) return yield* fail("Say which folder it works in with `cwd`.");
          const model = request.model?.trim() || undefined;
          const located = adapter.locate
            ? yield* locate({ ...adapter, locate: adapter.locate }, raw, { options, model })
            : yield* resolveCwd(raw!, request.bot);
          const cwd = located.cwd;
          images = yield* imagesFor(adapter, cwd);
          session = yield* q.createSession({
            id: newId("ses"),
            bot: request.bot,
            harness: adapter.id,
            cwd,
            model: model ?? null,
            options: "options" in located && located.options ? { ...options, ...located.options } : options,
            parent: null,
          });
        }
        const title = clip((request.title?.trim() || firstLine(prompt)).replace(/\s+/g, " "), MAX_TITLE);
        const row = yield* q.createTask({ id: newId("task"), bot: request.bot, key: request.key, session: session.id, title, prompt, images }, "queued");
        yield* q.touchSession(session.id);
        const live = yield* spawnLive(row, session, adapter);
        yield* log(live, "state", "queued");
        yield* changed(live);
        return { snapshot: yield* snapshotOf(live.row), created: true };
      }),
    );

  const read: Tasks["read"] = (bot, id, after, limit) =>
    Effect.gen(function* () {
      yield* flush;
      const row = yield* owned(bot, id);
      const snapshot = yield* snapshotOf(lives.get(row.id)?.row ?? row);
      const first = yield* q.firstEventSeq(row.id);
      const page = yield* q.events(row.id, Math.max(0, after), Math.min(Math.max(1, limit), MAX_READ));
      let total = 0;
      const kept: TaskEventRow[] = [];
      for (const e of page.events) {
        total += e.text.length + 40;
        if (total > READ_CHARS && kept.length) break;
        kept.push(e);
      }
      const more = page.more || kept.length < page.events.length;
      const cursor = kept.at(-1)?.seq ?? Math.max(after, 0);
      return { ...snapshot, events: kept, more, pruned: first > 0 && after < first - 1 && after > 0, cursor };
    });

  const send: Tasks["send"] = (bot, id, key, mode, text) =>
    Effect.gen(function* () {
      const row = yield* owned(bot, id);
      const existing = yield* q.messageByKey(key);
      if (existing) return { message: existing, duplicate: true };
      const body = text.trim();
      if (!body) return yield* fail("The message is empty.");
      if (body.length > MAX_PROMPT) return yield* fail(`Keep the message under ${MAX_PROMPT} characters.`);
      const live = lives.get(row.id);
      const session = (yield* q.session(row.session))!;
      const adapter = adapters.get(session.harness);
      // Said as it always was, except for a harness that can't continue a session.
      const next = adapter && !adapter.capabilities.resume ? "" : ` To carry on, call collar__task_start with "session": "${session.id}".`;
      if (taskEnded(row.state) || !live) return yield* fail(`Task ${row.id} has ended (${row.state}).${next}`);
      if (!adapter?.capabilities[mode === "steer" ? "steer" : "queue"])
        return yield* fail(`${label(session.harness)} can't take ${mode === "steer" ? "steering" : "queued"} messages.`);
      if (live.cancelling || live.closing) return yield* fail(`Task ${row.id} is ending; it takes no more messages.${next}`);
      if (mode === "steer" && (live.phase !== "started" || !live.turnActive))
        return yield* fail(`No turn is running to steer (task ${row.id} is ${live.row.state}). Send it with mode "queue" to run after.`);
      const ending = `Task ${row.id} is ending; it takes no more messages.${next}`;
      const admitted = yield* live.lock.withPermits(1)(
        Effect.gen(function* () {
          if (live.cancelling || live.closing) return undefined;
          return (yield* q.addMessage({ task: row.id, bot, key, mode, text: body })).message;
        }),
      );
      if (!admitted) return yield* fail(ending);
      const message = admitted;
      if (mode === "queue") {
        Queue.offerUnsafe(live.signals, { type: "queued", message });
        return { message, duplicate: false };
      }
      const reply = yield* Deferred.make<string | undefined>();
      live.steering.add(reply);
      if (live.finished) Deferred.doneUnsafe(reply, Effect.succeed(STEER_TOO_LATE));
      Queue.offerUnsafe(live.signals, { type: "steer", message, reply });
      const answer = yield* Deferred.await(reply).pipe(Effect.timeoutOption(Duration.millis(STEER_TIMEOUT_MS)));
      if (answer._tag === "None")
        return yield* fail(`${label(session.harness)} didn't confirm the message within ${STEER_TIMEOUT_MS / 1000} s; check collar__task_read.`);
      if (answer.value !== undefined) return yield* fail(answer.value);
      return { message: (yield* q.messageByKey(key)) ?? message, duplicate: false };
    });

  const respond: Tasks["respond"] = (by, bot, id, inputId, answer) =>
    Effect.gen(function* () {
      const row = yield* owned(bot, id);
      const input = yield* q.input(inputId);
      if (!input || input.task !== row.id) return yield* fail(`Task ${row.id} has no request ${inputId}.`);
      if (input.state === "answered")
        return yield* fail(`Request ${inputId} was already answered${input.answeredBy ? ` by the ${input.answeredBy === "bot" ? "bot" : "user"}` : ""}.`);
      if (input.state === "withdrawn") return yield* fail(`Request ${inputId} isn't waiting anymore: it was withdrawn.`);
      const live = lives.get(row.id);
      if (!live || live.finished) return yield* fail(`Task ${row.id} isn't waiting for that anymore.`);
      const given = answer.answers;
      const answers: Record<string, string[]> = {};
      for (const question of input.questions) {
        const values = (given[question.id] ?? []).map((v) => v.trim()).filter(Boolean);
        if (!values.length) return yield* fail(`Answer question ${JSON.stringify(question.id)} ("${clip(question.question, 120)}") in \`answers\`.`);
        if (!question.multiple && values.length > 1) return yield* fail(`Question ${JSON.stringify(question.id)} takes one answer.`);
        if (values.some((v) => v.length > MAX_TASK_ANSWER)) return yield* fail(`Keep each answer under ${MAX_TASK_ANSWER} characters.`);
        answers[question.id] = values;
      }
      const unknown = Object.keys(given).filter((k) => !input.questions.some((q) => q.id === k));
      if (unknown.length) return yield* fail(`Request ${inputId} has no question ${unknown.map((k) => JSON.stringify(k)).join(", ")}.`);
      const mapped: HarnessAnswer = { kind: "question", answers };
      const stored = { answers };
      const answered = yield* q.answerInput(inputId, stored, by);
      if (!answered) return yield* fail(`Request ${inputId} was already answered.`);
      // The bot hears whether the harness took its answer; the user's card shows it by coming back.
      const wait: AnswerWait | undefined = by === "bot" ? { reply: yield* Deferred.make<string | undefined>(), listening: true } : undefined;
      Queue.offerUnsafe(live.signals, { type: "answered", input: answered, answer: mapped, reply: wait });
      if (!wait) return answered;
      const outcome = yield* Deferred.await(wait.reply).pipe(Effect.timeoutOption(Duration.millis(STEER_TIMEOUT_MS)));
      if (outcome._tag === "None") wait.listening = false;
      else if (outcome.value !== undefined) return yield* fail(outcome.value);
      return answered;
    });

  const wait: Tasks["wait"] = (bot, id, ms, until, signal) =>
    Effect.gen(function* () {
      const row = yield* owned(bot, id);
      const deadline = (yield* now) + Math.max(0, ms);
      for (;;) {
        const live = lives.get(row.id);
        const current = live?.row ?? (yield* q.task(row.id))!;
        const ready = !live || taskEnded(current.state) || (until === "input_or_end" && current.state === "waiting_for_input");
        const left = deadline - (yield* now);
        if (ready || left <= 0) return { snapshot: yield* snapshotOf(current), timedOut: !ready };
        const tick = live!.tick;
        if (until === "end") live!.waitersEnd++;
        else live!.waitersAny++;
        const woke = yield* Deferred.await(tick).pipe(
          Effect.as(true),
          Effect.timeoutOption(Duration.millis(left)),
          (waiting) => Effect.raceFirst(waiting, Effect.as(Effect.ignore(stopped(signal)), undefined)),
          Effect.ensuring(
            Effect.sync(() => {
              if (until === "end") live!.waitersEnd--;
              else live!.waitersAny--;
            }),
          ),
        );
        if (woke === undefined) return yield* fail("Stopped waiting.");
      }
    });

  const cancel: Tasks["cancel"] = (bot, id) =>
    Effect.gen(function* () {
      const row = yield* owned(bot, id);
      const live = lives.get(row.id);
      if (!live || taskEnded(row.state)) return { task: (yield* q.task(row.id))!, cancelled: false };
      // Nothing is touched: no stop is sent, nothing is killed, and the task's state stays as it is.
      if (!live.adapter.capabilities.cancel)
        return yield* fail(
          `${live.adapter.label} can't stop a task${inCloud(live.adapter) ? " from Top: it runs in its vendor's cloud" : ""}, so task ${row.id} goes on (${row.state}).${follows(live.adapter.capabilities) ? " You'll get a message when it ends." : ""}`,
        );
      yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const pending = yield* live.lock.withPermits(1)(
            Effect.gen(function* () {
              live.cancelling = true;
              // A recovered durable task may be running in the harness before its actor starts: the actor stops it there.
              if (live.phase !== "pending" || live.resumed) return false;
              if (live.fiber) yield* Fiber.interrupt(live.fiber);
              return true;
            }),
          );
          if (pending) yield* finish(live, "cancelled");
          else {
            // Saved before it's acted on, so a durable harness's task is still stopped if Top restarts meanwhile.
            if (!(yield* q.cancelRequested(live.id)))
              yield* q.appendEvents([{ task: live.id, bot: live.bot, at: yield* now, kind: "state", text: "cancelling" }]);
            Queue.offerUnsafe(live.signals, { type: "cancel" });
          }
          yield* Deferred.succeed(live.cancelRequested, undefined);
        }),
      );
      yield* Deferred.await(live.done).pipe(Effect.timeout(Duration.millis(cancelGraceMs * 3 + 20_000)), Effect.ignore);
      const after = (yield* q.task(row.id))!;
      return { task: after, cancelled: after.state === "cancelled" };
    });

  /** Stops following a task its harness can't stop, without a word to the harness: it ends `handed_off`, saying so. */
  const release = (live: Live) =>
    Effect.gen(function* () {
      const known = live.session.externalId && !live.session.externalId.startsWith("pending:");
      const why = `Top stopped following it when its bot was deleted, without stopping it in ${live.adapter.label}${known ? `, where it may still be running (${live.session.externalId})` : ""}.`;
      const pending = yield* live.lock.withPermits(1)(
        Effect.gen(function* () {
          if (live.phase !== "pending" || live.resumed) return false;
          live.cancelling = true;
          if (live.fiber) yield* Fiber.interrupt(live.fiber);
          return true;
        }),
      );
      // Never started, so nothing reached the harness: it's simply cancelled.
      if (pending) return yield* finish(live, "cancelled");
      Queue.offerUnsafe(live.signals, { type: "release", why });
      yield* Deferred.await(live.done).pipe(Effect.timeout(Duration.seconds(30)), Effect.ignore);
    });

  const stopAll: Tasks["stopAll"] = (bot, forget = false) =>
    Effect.asVoid(
      Effect.forEach(
        [...lives.values()].filter((l) => l.bot === bot && (forget || l.adapter.capabilities.cancel)),
        (live) => (live.adapter.capabilities.cancel ? cancel(bot, live.id) : release(live)).pipe(Effect.ignore),
        { concurrency: "unbounded" },
      ),
    );

  /**
   * Looks at what a watched harness did in a session while no task followed it, and accounts for each run once: a run of
   * Top's work gets a task that follows it and reports its answer (sending nothing); a person's turn in the harness, a
   * monitor's progress, a run of a cancelled task's work, or a wake Top can't link to its work gets none. The first look
   * at a session Top kept no account of yet only takes note of the runs that had ended.
   */
  const lookOnce = (sessionId: string) =>
    Effect.gen(function* () {
      const session = yield* q.session(sessionId);
      const adapter = session ? adapters.get(session.harness) : undefined;
      const watch = adapter ? watches.get(adapter.id) : undefined;
      if (!session?.externalId || !adapter || !watch) return;
      if ([...lives.values()].some((l) => l.session.id === sessionId)) return;
      // With what Top accounted for, so a chain through a run a task took leads to that task.
      const known = yield* q.runsOf(sessionId);
      const environment = typeof session.options.environment === "string" ? session.options.environment : undefined;
      const reviewed = yield* Effect.option(Effect.tryPromise(() => watch.review(session.externalId!, known, environment)));
      // Couldn't read it: the change that brought Top here won't come again, so it looks again later.
      if (reviewed._tag === "None") return "retry" as const;
      // Under the lock `task_start` takes, spawning included: a bot's task and a continuation never both take the session.
      yield* starting.withPermits(1)(
        Effect.gen(function* () {
          if ([...lives.values()].some((l) => l.session.id === sessionId) || (yield* q.sessionBusy(sessionId, ""))) return;
          const accounted = yield* q.runsOf(sessionId);
          const firstLook = !(yield* q.session(sessionId))?.baselined;
          const accounts: RunAccount[] = [];
          const notes: string[] = [];
          const note = Effect.gen(function* () {
            const last = notes.length ? yield* q.latestTaskOf(sessionId) : undefined;
            if (last)
              yield* q.appendEvents(
                notes.map((run) => ({
                  task: last.id,
                  bot: last.bot,
                  at: Date.now(),
                  kind: "status" as const,
                  text: `${label(session.harness)} ran on its own in this session (run ${run}) with nothing linking it to Top's work, and someone else also writes in its thread there, so Top didn't report it.`,
                })),
              );
          });
          for (const r of reviewed.value) {
            if (accounted.has(r.run)) continue;
            if (firstLook && r.ended) {
              accounts.push({ run: r.run, task: null, kind: "baseline" });
              continue;
            }
            const owner = r.owner;
            if (owner.kind === "top") {
              const root = owner.task ?? owner.key?.split(":m")[0];
              // A wake with no link has no root: the session's latest task stands for it, cancelled or not.
              const rootRow = root ? yield* q.task(root) : yield* q.latestTaskOf(sessionId);
              if (rootRow?.state === "cancelled") {
                accounts.push({ run: r.run, task: null, kind: "cancelled" });
                continue;
              }
              yield* note;
              const last = rootRow ?? (yield* q.latestTaskOf(sessionId));
              const title = clip(`${last?.title ?? "Task"} (continued)`, MAX_TITLE);
              const row = yield* q.createContinuation(
                {
                  id: newId("task"),
                  bot: session.bot,
                  key: `t3:${session.externalId}:${r.run}`,
                  session: sessionId,
                  title,
                  prompt: `${label(session.harness)} went on in session ${sessionId} on its own (run ${r.run}).`,
                  images: [],
                  continues: last?.id ?? null,
                  adopt: r.run,
                },
                accounts,
              );
              if (!row) return;
              // Followed like a task Top picks up after a restart: through T3 Code's reconnect window, not on one look.
              const live = yield* spawnLive(row, session, adapter, true);
              yield* log(live, "state", "queued");
              yield* log(
                live,
                "status",
                `${label(session.harness)} went on with task ${row.continues ?? "?"}'s session on its own: following it (run ${row.adopt})`,
              );
              yield* changed(live);
              return;
            }
            accounts.push({ run: r.run, task: null, kind: owner.kind === "unknown" ? "unlinked" : owner.kind });
            if (owner.kind === "unknown") notes.push(r.run);
          }
          yield* q.accountRuns(sessionId, session.bot, accounts, firstLook);
          yield* note;
        }),
      );
    });

  /**
   * One look at a session at a time; a change during it gets one more look after. A look that couldn't read the thread
   * tries again later, backing off to every few minutes, until one gets through.
   */
  const look = (sessionId: string, delay = 2_000): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (looking.has(sessionId)) {
        looking.set(sessionId, true);
        return Effect.void;
      }
      looking.set(sessionId, false);
      return lookOnce(sessionId).pipe(
        Effect.catchCause((cause) => Effect.as(Effect.logWarning(`Top couldn't look at session ${sessionId}`, cause), "retry" as const)),
        Effect.flatMap((outcome) =>
          Effect.suspend(() => {
            const again = looking.get(sessionId) === true;
            looking.delete(sessionId);
            if (again) return look(sessionId);
            if (outcome !== "retry" || !watches.size) return Effect.void;
            return Effect.asVoid(Effect.forkIn(Effect.andThen(Effect.sleep(Duration.millis(delay)), look(sessionId, Math.min(delay * 2, 300_000))), scope));
          }),
        ),
      );
    });

  /** The watched threads that changed: the sessions they belong to get a look, unless their thread is archived there. */
  const threadsChanged = (adapter: HarnessAdapter, threads: readonly WatchedThread[], environment: string, everything = false) =>
    Effect.gen(function* () {
      const byThread = new Map<string, SessionRow[]>();
      for (const session of yield* q.sessionsWithThreads(adapter.id)) {
        const env = session.options.environment;
        if (typeof env === "string" && env !== environment) continue;
        byThread.set(session.externalId!, [...(byThread.get(session.externalId!) ?? []), session]);
      }
      for (const thread of threads) {
        if (thread.archived) continue;
        for (const session of byThread.get(thread.externalId) ?? []) {
          // Only what changed since Top last looked: a latest or active run it hasn't accounted for.
          const accounted = yield* q.runsOf(session.id);
          const fresh = [thread.latestRunId, thread.activeRunId].some((run) => run && !accounted.has(run));
          // When Top starts, every session gets one look: a crash may have come between a task's end and the look after it.
          if (everything || fresh || (thread.latestRunId === undefined && thread.activeRunId === undefined)) yield* Effect.forkIn(look(session.id), scope);
        }
      }
    });

  const startWatching = Effect.gen(function* () {
    for (const adapter of config.adapters) {
      if (!adapter.watch || watches.has(adapter.id)) continue;
      const services = yield* Effect.context<never>();
      const run = Effect.runForkWith(services);
      let first = true;
      watches.set(
        adapter.id,
        adapter.watch((threads, environment) => {
          run(threadsChanged(adapter, threads, environment, first).pipe(Effect.ignoreCause({ log: true })));
          first = false;
        }),
      );
    }
    yield* Scope.addFinalizer(
      scope,
      Effect.sync(() => {
        for (const watch of watches.values()) watch.close();
        watches.clear();
      }),
    );
  });

  const recover: Tasks["recover"] = Effect.gen(function* () {
    let cut = 0;
    for (const row of yield* q.activeTasks) {
      const session = yield* q.session(row.session);
      const adapter = session ? adapters.get(session.harness) : undefined;
      if (session && adapter && row.startedAt === null) {
        yield* spawnLive(row, session, adapter);
        continue;
      }
      if (session && adapter?.capabilities.durable) {
        yield* spawnLive(row, session, adapter, true, yield* q.cancelRequested(row.id));
        continue;
      }
      cut++;
      yield* q.withdrawInputs(row.id);
      const dropped = yield* q.dropMessages(row.id);
      const when = row.startedAt === null ? "before it started" : "while it ran";
      const why = !adapter
        ? `its harness (${session?.harness ?? "unknown"}) isn't available on this daemon anymore`
        : inCloud(adapter)
          ? `the daemon restarted while it was handing the task to ${adapter.label}, so Top can't tell whether it got there. Check there before starting it again: Top never sends it twice`
          : `the daemon restarted ${when}, so ${adapter.label} stopped with it. It may have made some of its changes`;
      const resume = session ? carryOn(session, adapter) : "";
      const ended = yield* q.setState(row.id, ACTIVE_STATES, "failed", {
        error: `Cut off: ${why}.${resume}${dropped ? ` (${dropped} queued message${dropped === 1 ? " was" : "s were"} not sent.)` : ""}`,
      });
      if (ended && session) {
        const message = yield* q.notify(ended.id, ended.state, notifyText(ended, session, adapter?.label ?? session.harness, adapter));
        if (message) yield* events.deliver(message);
      }
    }
    for (const ended of yield* q.unnotified) {
      const session = yield* q.session(ended.session);
      if (!session) continue;
      const message = yield* q.notify(ended.id, ended.state, notifyText(ended, session, label(session.harness), adapters.get(session.harness)));
      if (message) yield* events.deliver(message);
    }
    yield* Queue.offer(dirty, undefined);
    yield* startWatching;
    return cut;
  });

  yield* Effect.forkIn(
    Effect.forever(
      Effect.gen(function* () {
        yield* Effect.sleep(Duration.millis(FLUSH_MS));
        yield* flush.pipe(Effect.ignoreCause({ log: true }));
      }),
    ),
    scope,
  );
  yield* Effect.forkIn(
    Effect.forever(
      Effect.gen(function* () {
        yield* Queue.take(dirty);
        yield* Effect.sleep(Duration.millis(PUBLISH_MS));
        const current = yield* waitingNow;
        const json = JSON.stringify(current);
        if (json !== publishedJson) {
          published = current;
          publishedJson = json;
          yield* events.publish(current);
        }
      }),
    ),
    scope,
  );

  const tasks: Tasks = {
    adapters: config.adapters,
    start,
    read,
    snapshot: (bot, id) => Effect.flatMap(owned(bot, id), (row) => snapshotOf(lives.get(row.id)?.row ?? row)),
    send,
    respond,
    wait,
    cancel,
    sessions: (bot) => q.sessionsOf(bot, 20),
    waiting: Effect.sync(() => published),
    stopAll,
    recover,
  };
  return tasks;
});
