import { randomBytes } from "node:crypto";
import { mkdir, realpath, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { MAX_TASK_ANSWER, type TaskAnswers, TaskError, type TaskInputView, type TaskState, type TaskView, taskEnded } from "@top/protocol";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";
import Value from "typebox/value";
import type { InboxRow } from "../store.ts";
import { duration } from "../time.ts";
import { stopped } from "../tools.ts";
import { clip, type HarnessAdapter, type HarnessAnswer, type HarnessEvent, type HarnessSession, HarnessUnavailable, redact, type Usage } from "./harness.ts";
import {
  ACTIVE_STATES,
  type NewEvent,
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
const RECENT_VIEWS = 40;
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
  readonly publish: (views: readonly TaskView[]) => Effect.Effect<void>;
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
  readonly views: Effect.Effect<readonly TaskView[]>;
  readonly stopAll: (bot: number) => Effect.Effect<void>;
  readonly recover: Effect.Effect<number>;
};

type Signal =
  | { readonly type: "harness"; readonly event: HarnessEvent }
  | { readonly type: "answered"; readonly input: TaskInputRow; readonly answer: HarnessAnswer }
  | { readonly type: "steer"; readonly message: TaskMessageRow; readonly reply: Deferred.Deferred<string | undefined> }
  | { readonly type: "queued"; readonly message: TaskMessageRow }
  | { readonly type: "cancel" }
  | { readonly type: "cancel_timeout" };

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
  harness: HarnessSession | undefined;
  turnActive: boolean;
  cancelling: boolean;
  stopping: boolean;
  closing: boolean;
  finished: boolean;
  waitersAny: number;
  waitersEnd: number;
  tick: Deferred.Deferred<void>;
  latest: string | undefined;
  readonly inputs: Map<number, TaskInputRow>;
  readonly external: Map<string, number>;
  readonly steering: Set<Deferred.Deferred<string | undefined>>;
  result: string | undefined;
  usage: Usage | undefined;
  events: number;
};

const fail = (message: string) => Effect.fail(new TaskError({ message }));
const newId = (prefix: string) => `${prefix}_${randomBytes(8).toString("base64url").replace(/[-_]/g, "x").slice(0, 10)}`;
const firstLine = (text: string) => clip(text.trim().split("\n")[0]?.trim() ?? "", 200);

export function notifyText(task: TaskRow, session: SessionRow, label: string): string {
  const head = `[Task ${task.id} ${task.state === "completed" ? "completed" : task.state === "cancelled" ? "was cancelled" : "failed"}] ${task.title} (${label})`;
  const ran = task.startedAt && task.endedAt ? `, after ${duration(task.endedAt - task.startedAt)}` : "";
  const body =
    task.state === "completed"
      ? task.result
        ? clip(task.result, NOTIFY_RESULT_CHARS)
        : "(no answer text)"
      : (task.error ?? (task.state === "cancelled" ? "Cancelled." : "It failed."));
  const more = task.result && task.result.length > NOTIFY_RESULT_CHARS ? `\n\nThe whole answer is in collar__task_read {"id": "${task.id}"}.` : "";
  return `${head}${ran}\n\n${body}${more}\n\nIts session is ${session.id}: to carry on with it, call collar__task_start with "session": "${session.id}".`;
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
  let buffer: NewEvent[] = [];
  let progressed = false;
  const dirty = yield* Queue.sliding<void>(1);
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
      if (kind !== "state" && kind !== "usage") {
        live.latest = firstLine(clipped);
        progressed = true;
      }
    });

  const inputView = (row: TaskInputRow): TaskInputView => ({ id: row.id, title: row.title, questions: [...row.questions] });

  const views: Effect.Effect<readonly TaskView[]> = Effect.gen(function* () {
    const rows = yield* q.recentTasks(RECENT_VIEWS);
    const pending = yield* q.pendingInputs;
    const result: TaskView[] = [];
    for (const row of rows) {
      const session = yield* q.session(row.session);
      if (!session) continue;
      const latest = lives.get(row.id)?.latest ?? (row.result ? firstLine(row.result) : undefined);
      result.push({
        id: row.id,
        bot: row.bot,
        harness: label(session.harness),
        title: row.title,
        state: row.state,
        session: session.id,
        cwd: session.cwd,
        ...(session.model ? { model: session.model } : {}),
        createdAt: row.createdAt,
        ...(row.endedAt ? { endedAt: row.endedAt } : {}),
        ...(latest ? { latest } : {}),
        ...(row.error ? { error: firstLine(row.error) } : {}),
        inputs: pending.filter((i) => i.task === row.id).map(inputView),
      });
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

  const finish = (live: Live, state: "completed" | "failed" | "cancelled", end: { result?: string | undefined; error?: string | undefined } = {}) =>
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
            return count;
          }),
        );
        const kept = end.result ?? live.result;
        const result = kept === undefined ? undefined : scrub(kept);
        const said = end.error === undefined ? undefined : scrub(end.error);
        const error = said && dropped ? `${said}\n(${dropped} queued message${dropped === 1 ? " was" : "s were"} not sent.)` : said;
        const row = yield* q.setState(live.id, ACTIVE_STATES, state, {
          ...(result !== undefined ? { result: clip(result, RESULT_CHARS) } : {}),
          ...(error !== undefined ? { error: clip(error, 4_000) } : {}),
        });
        if (live.usage) yield* q.setUsage(live.id, live.usage);
        if (row) live.row = row;
        yield* log(live, "state", state + (error ? `: ${error}` : ""));
        yield* flush;
        lives.delete(live.id);
        const suppressed = live.waitersAny + live.waitersEnd > 0;
        if (row) yield* notify(live, row.state, notifyText(row, live.session, label(live.session.harness)), suppressed);
        yield* changed(live);
        yield* Deferred.succeed(live.done, undefined);
      }),
    );

  const emitTo = (live: Live) => (event: HarnessEvent) => {
    Queue.offerUnsafe(live.signals, { type: "harness", event });
  };

  const runTurn = (live: Live, text: string, images: readonly string[]) =>
    Effect.gen(function* () {
      const harness = live.harness!;
      live.turnActive = true;
      const ran = yield* Effect.raceFirst(
        Effect.result(Effect.tryPromise(() => harness.run({ text, images }))),
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

  const cancelInputs = (live: Live) =>
    Effect.gen(function* () {
      for (const input of live.inputs.values()) if (input.external) live.harness?.answer(input.external, { kind: "cancelled" });
      live.inputs.clear();
      live.external.clear();
      yield* q.withdrawInputs(live.id);
    });

  const afterInput = (live: Live) =>
    live.inputs.size === 0 && live.row.state === "waiting_for_input" ? setState(live, ["waiting_for_input"], "running") : Effect.succeed(true);

  const handle = (live: Live, signal: Signal): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (live.finished) {
        if (signal.type === "steer") yield* Deferred.succeed(signal.reply, "The task has ended.");
        return;
      }
      switch (signal.type) {
        case "harness": {
          const event = signal.event;
          switch (event.type) {
            case "session":
              if (live.session.externalId !== event.externalId) {
                yield* q.setExternalId(live.session.id, event.externalId);
                live.session = { ...live.session, externalId: event.externalId };
              }
              return;
            case "log":
              yield* log(live, event.kind, event.text);
              return;
            case "usage":
              live.usage = event.usage;
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
                options: question.options.map((option) => ({
                  ...option,
                  label: scrub(option.label),
                  ...(option.description === undefined ? {} : { description: scrub(option.description) }),
                })),
              }));
              const { input } = yield* q.addInput({ task: live.id, bot: live.bot, external: request.id, title, questions });
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
              if (id === undefined) return;
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
              if (live.inputs.size) yield* cancelInputs(live);
              if (event.status === "completed") {
                live.result = event.result ?? live.result;
                const next = yield* live.lock.withPermits(1)(
                  Effect.gen(function* () {
                    if (!live.cancelling)
                      for (const candidate of (yield* q.pendingMessages(live.id)).filter((m) => m.mode === "queue"))
                        if (yield* q.setMessageState(candidate.id, "sent")) return candidate;
                    live.closing = true;
                    return undefined;
                  }),
                );
                if (!next) return yield* finish(live, "completed", { result: live.result ?? "" });
                yield* log(live, "sent", `queued message ${next.id} started a new turn`);
                if (live.row.state === "waiting_for_input") yield* setState(live, ["waiting_for_input"], "running");
                yield* runTurn(live, next.text, []);
                return;
              }
              if (live.cancelling) return yield* finish(live, "cancelled");
              if (event.status === "interrupted")
                return yield* finish(live, "failed", { error: event.error ?? `${label(live.session.harness)} stopped the turn before it finished.` });
              return yield* finish(live, "failed", { error: event.error ?? "The turn failed." });
            }
            case "exited": {
              if (live.cancelling) return yield* finish(live, "cancelled");
              const resumable = live.session.externalId
                ? ` Its session ${live.session.id} is kept: to carry on, call collar__task_start with "session": "${live.session.id}".`
                : "";
              return yield* finish(live, "failed", { error: `${event.error}.${resumable}` });
            }
          }
          return;
        }
        case "answered": {
          const { input, answer } = signal;
          live.inputs.delete(input.id);
          if (input.external) {
            live.external.delete(input.external);
            live.harness?.answer(input.external, answer);
          }
          yield* log(live, "answer", `request ${input.id}: answered by the ${input.answeredBy ?? "user"}`);
          if (yield* afterInput(live)) yield* changed(live);
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
          if (!live.turnActive && live.harness && !live.cancelling && live.row.state === "running" && (yield* q.setMessageState(signal.message.id, "sent")))
            yield* runTurn(live, signal.message.text, []);
          return;
        case "cancel": {
          if (live.stopping) return;
          live.stopping = true;
          live.cancelling = true;
          yield* cancelInputs(live);
          if (!live.turnActive || !live.harness) return yield* finish(live, "cancelled");
          const harness = live.harness;
          yield* log(live, "status", "cancelling: stopping the turn");
          yield* Effect.forkIn(
            Effect.promise(() => harness.interrupt().catch(() => {})),
            scope,
          );
          yield* Effect.forkIn(
            Effect.sleep(Duration.millis(cancelGraceMs)).pipe(Effect.andThen(Effect.sync(() => Queue.offerUnsafe(live.signals, { type: "cancel_timeout" })))),
            scope,
          );
          return;
        }
        case "cancel_timeout":
          return yield* finish(live, "cancelled");
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
      return { cwd: session.cwd, model: session.model ?? undefined, options: session.options, resume, fork };
    });

  const runStarted = (live: Live) =>
    Effect.gen(function* () {
      const begun = yield* live.lock.withPermits(1)(
        Effect.gen(function* () {
          if (live.cancelling) return false;
          if (!(yield* setState(live, ["queued"], "starting"))) return false;
          live.phase = "started";
          return true;
        }),
      );
      if (!begun) return;
      const adapter = live.adapter;
      const available = yield* Effect.raceFirst(
        Effect.promise(() => adapter.check().catch((error: unknown) => ({ ok: false as const, error: String(error) }))),
        Effect.as(Deferred.await(live.cancelRequested), "cancelled" as const),
      );
      if (available === "cancelled") return yield* finish(live, "cancelled");
      if (!available.ok) return yield* finish(live, "failed", { error: available.error });
      yield* log(live, "status", `${adapter.label} ${available.version}`);
      if (live.cancelling) return yield* finish(live, "cancelled");
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
      const opened = yield* Effect.raceFirst(open, Effect.as(Deferred.await(live.cancelRequested), "cancelled" as const));
      if (opened === "cancelled") return yield* finish(live, "cancelled");
      if (opened._tag === "Failure") {
        const cause = opened.failure.cause;
        const message =
          cause instanceof HarnessUnavailable ? cause.message : `${adapter.label} didn't start: ${cause instanceof Error ? cause.message : String(cause)}`;
        return yield* finish(live, "failed", { error: message });
      }
      live.harness = opened.success;
      if (live.cancelling) return yield* finish(live, "cancelled");
      if (!(yield* setState(live, ["starting"], "running"))) return yield* finish(live, "cancelled");
      if (live.cancelling) return yield* finish(live, "cancelled");
      if (!(yield* runTurn(live, live.row.prompt, live.row.images))) return;
      while (!live.finished) yield* handle(live, yield* Queue.take(live.signals));
    }).pipe(Effect.ensuring(closeHarness(live)));

  const actor = (live: Live) =>
    Effect.gen(function* () {
      yield* slots.withPermits(1)(runStarted(live));
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

  const spawnLive = (row: TaskRow, session: SessionRow, adapter: HarnessAdapter) =>
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
        harness: undefined,
        turnActive: false,
        cancelling: false,
        stopping: false,
        closing: false,
        finished: false,
        waitersAny: 0,
        waitersEnd: 0,
        tick: yield* Deferred.make<void>(),
        latest: undefined,
        inputs: new Map(),
        external: new Map(),
        steering: new Set(),
        result: undefined,
        usage: undefined,
        events: 0,
      };
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
          if (request.cwd !== undefined) {
            const { cwd } = yield* resolveCwd(request.cwd, request.bot);
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
          const options = yield* checkOptions(adapter, request.options ?? {});
          const folder = config.folder ? yield* config.folder(request.bot) : undefined;
          const raw = request.cwd ?? folder;
          if (raw === undefined) return yield* fail("Say which folder it works in with `cwd`.");
          const { cwd } = yield* resolveCwd(raw, request.bot);
          images = yield* imagesFor(adapter, cwd);
          session = yield* q.createSession({
            id: newId("ses"),
            bot: request.bot,
            harness: adapter.id,
            cwd,
            model: request.model?.trim() || null,
            options,
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
      if (taskEnded(row.state) || !live)
        return yield* fail(`Task ${row.id} has ended (${row.state}). To carry on, call collar__task_start with "session": "${session.id}".`);
      if (!adapter?.capabilities[mode === "steer" ? "steer" : "queue"])
        return yield* fail(`${label(session.harness)} can't take ${mode === "steer" ? "steering" : "queued"} messages.`);
      if (live.cancelling || live.closing)
        return yield* fail(`Task ${row.id} is ending; it takes no more messages. To carry on, call collar__task_start with "session": "${session.id}".`);
      if (mode === "steer" && (live.phase !== "started" || !live.turnActive))
        return yield* fail(`No turn is running to steer (task ${row.id} is ${live.row.state}). Send it with mode "queue" to run after.`);
      const ending = `Task ${row.id} is ending; it takes no more messages. To carry on, call collar__task_start with "session": "${session.id}".`;
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
      Queue.offerUnsafe(live.signals, { type: "answered", input: answered, answer: mapped });
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
      yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const pending = yield* live.lock.withPermits(1)(
            Effect.gen(function* () {
              live.cancelling = true;
              if (live.phase !== "pending") return false;
              if (live.fiber) yield* Fiber.interrupt(live.fiber);
              return true;
            }),
          );
          if (pending) yield* finish(live, "cancelled");
          else Queue.offerUnsafe(live.signals, { type: "cancel" });
          yield* Deferred.succeed(live.cancelRequested, undefined);
        }),
      );
      yield* Deferred.await(live.done).pipe(Effect.timeout(Duration.millis(cancelGraceMs + 20_000)), Effect.ignore);
      const after = (yield* q.task(row.id))!;
      return { task: after, cancelled: after.state === "cancelled" };
    });

  const stopAll: Tasks["stopAll"] = (bot) =>
    Effect.asVoid(
      Effect.forEach(
        [...lives.values()].filter((l) => l.bot === bot),
        (live) => cancel(bot, live.id).pipe(Effect.ignore),
        { concurrency: "unbounded" },
      ),
    );

  const recover: Tasks["recover"] = Effect.gen(function* () {
    let cut = 0;
    for (const row of yield* q.activeTasks) {
      const session = yield* q.session(row.session);
      const adapter = session ? adapters.get(session.harness) : undefined;
      if (session && adapter && row.startedAt === null) {
        yield* spawnLive(row, session, adapter);
        continue;
      }
      cut++;
      yield* q.withdrawInputs(row.id);
      const dropped = yield* q.dropMessages(row.id);
      const when = row.startedAt === null ? "before it started" : "while it ran";
      const why = !adapter
        ? `its harness (${session?.harness ?? "unknown"}) isn't available on this daemon anymore`
        : `the daemon restarted ${when}, so ${adapter.label} stopped with it. It may have made some of its changes`;
      const resume = session?.externalId ? ` Its session ${session.id} is kept: to carry on, call collar__task_start with "session": "${session.id}".` : "";
      const ended = yield* q.setState(row.id, ACTIVE_STATES, "failed", {
        error: `Cut off: ${why}.${resume}${dropped ? ` (${dropped} queued message${dropped === 1 ? " was" : "s were"} not sent.)` : ""}`,
      });
      if (ended && session) {
        const message = yield* q.notify(ended.id, ended.state, notifyText(ended, session, adapter?.label ?? session.harness));
        if (message) yield* events.deliver(message);
      }
    }
    for (const ended of yield* q.unnotified) {
      const session = yield* q.session(ended.session);
      if (!session) continue;
      const message = yield* q.notify(ended.id, ended.state, notifyText(ended, session, label(session.harness)));
      if (message) yield* events.deliver(message);
    }
    yield* Queue.offer(dirty, undefined);
    return cut;
  });

  yield* Effect.forkIn(
    Effect.forever(
      Effect.gen(function* () {
        yield* Effect.sleep(Duration.millis(FLUSH_MS));
        yield* flush.pipe(Effect.ignoreCause({ log: true }));
        if (progressed) {
          progressed = false;
          yield* Queue.offer(dirty, undefined);
        }
      }),
    ),
    scope,
  );
  yield* Effect.forkIn(
    Effect.forever(
      Effect.gen(function* () {
        yield* Queue.take(dirty);
        yield* Effect.sleep(Duration.millis(PUBLISH_MS));
        yield* events.publish(yield* views);
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
    views,
    stopAll,
    recover,
  };
  return tasks;
});
