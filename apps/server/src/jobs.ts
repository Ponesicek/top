/**
 * Tool calls that run too long go on in the background.
 *
 * Every tool call gets a time limit (`TOP_TOOL_FOREGROUND_MS`, 30 seconds by default). A call still
 * running when it's up becomes a background job: the model gets a result at once saying so, the task
 * goes on, and the call keeps running. When it ends, its result comes to the bot as a message (an
 * inbox row with source `job`): mid-task it lands at the bot's next step, and if the bot is idle it
 * starts a new task. The bot needn't poll; it can look at a job's output so far, wait for it, or stop
 * it with Collar's `jobs` tool.
 *
 * - The user's Stop stops the bot's background jobs too: they're part of the task that was stopped.
 * - A job is in memory only. If the daemon restarts while one runs, the bot is told it was cut off and
 *   may have taken effect (a command may even still be running).
 * - A tool marked `background: false` keeps the run waiting however long it takes.
 * - A job can repeat (`collar__background`'s `repeat_while`): while its result contains the bot's text,
 *   such as a wait on another agent that timed out, the call runs again and the bot isn't told. It hears
 *   once, when the result is something else. Waiting on an agent costs no turns until it's done.
 */

import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import { type InboxRow, type JobRow, Store } from "./store.ts";
import { duration } from "./time.ts";
import { sleep, stopped, type ToolArguments, type ToolContext, ToolError, type ToolResult, type TopTool, text } from "./tools.ts";
import { summarize } from "./wire.ts";

/** How long a tool call may keep a task waiting before it moves to the background (`TOP_TOOL_FOREGROUND_MS`). */
export const ForegroundMs = Config.Int("TOP_TOOL_FOREGROUND_MS").pipe(Config.withDefault(30_000));
/**
 * A call started straight in the background still gets this long: one that fails at once (a typo in
 * a command, a server that refuses) comes back as its result, not as a job that ends a moment later.
 */
const STARTUP_GRACE_MS = 1_000;
/** The most of a job's result that reaches the model; the end is kept, where a command's outcome is. */
const RESULT_CHARS = 30_000;
/** How long `stop` waits for a stopped job to wind down before answering. */
const STOP_GRACE_MS = 5_000;
/** A repeating call starts again no sooner than this after its last start, so one that answers at once isn't run in a tight loop. */
export const REPEAT_GAP_MS = 30_000;
/** A repeating job with no `stopAfterMs` stops after this long. */
export const REPEAT_LIMIT_MS = 24 * 60 * 60 * 1000;

export type Outcome = { readonly ok: true; readonly result: ToolResult } | { readonly ok: false; readonly error: unknown };

type Live = {
  readonly id: number;
  readonly bot: number;
  readonly tool: string;
  readonly summary: string;
  readonly startedAt: number;
  /** Stops the call cooperatively: it winds down and reports what it got to. */
  readonly controller: AbortController;
  readonly outcome: Deferred.Deferred<Outcome>;
  /** The output it reported last, if the tool reports progress. */
  readonly progress: { latest?: ToolResult };
  /** What it's for, in the bot's words (`collar__background`'s `note`). */
  readonly note: string;
  /** `jobs wait` calls waiting on it: while there are any, its result goes to them, not to the inbox. */
  waiters: number;
  stopping: boolean;
  /** It ran past the time the bot allowed and was stopped for that: the bot hears about it. */
  timedOut: boolean;
  /** How many times a repeating call has run. */
  readonly runs: { count: number };
};

export type JobView = { readonly id: number; readonly tool: string; readonly summary: string; readonly note: string; readonly startedAt: number };

/** How one call is run (see `Jobs.run`). */
export type JobOptions = {
  /** How long the task waits for the call before it moves to the background; 0: it moves at once. */
  readonly foregroundMs: number;
  /** Stop the call if it still runs this long after it started. */
  readonly stopAfterMs?: number;
  /** What the call is for; it heads the messages about the job. */
  readonly note?: string;
  /** Run the call again, without telling the bot, while its result contains this text (see the top of this file). */
  readonly repeatWhile?: string;
};

/** The text of a tool result; parts that aren't text are named. */
function resultText(result: ToolResult): string {
  return (result.content ?? []).map((part) => (part.type === "text" ? part.text : `[${part.type}]`)).join("\n");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function capped(value: string): string {
  if (value.length <= RESULT_CHARS) return value;
  return `[…the first ${value.length - RESULT_CHARS} characters are left out]\n${value.slice(-RESULT_CHARS)}`;
}

/** What the job's tool call came to, as the model reads it. */
export function outcomeText(outcome: Outcome): { text: string; failed: boolean } {
  if (!outcome.ok) return { text: capped(errorText(outcome.error)), failed: true };
  return { text: capped(resultText(outcome.result) || "(no output)"), failed: outcome.result.isError === true };
}

const outcomeOf = (exit: Exit.Exit<ToolResult, ToolError>): Outcome =>
  Exit.isSuccess(exit) ? { ok: true, result: exit.value } : { ok: false, error: Cause.squash(exit.cause) };

const label = (job: { tool: string; summary: string; note: string }) => {
  const call = job.summary ? `${job.tool} (${job.summary})` : job.tool;
  return job.note ? `${job.note}: ${call}` : call;
};

export type JobsEvents = {
  /** A job's message was queued for its bot. */
  readonly deliver: (row: InboxRow) => Effect.Effect<void>;
  /** The bot's set of running jobs changed. */
  readonly changed: (bot: number) => Effect.Effect<void>;
};

export type Jobs = {
  readonly foregroundMs: number;
  /** The tool, with calls that outrun the time limit moved to the background. */
  readonly wrap: (tool: TopTool) => TopTool;
  /**
   * Run one call: its result if it ends within `foregroundMs`, else it goes on as a job and the result
   * says so. `ctx.key` names the job, so the same call is never two jobs.
   */
  readonly run: (tool: TopTool, args: ToolArguments, ctx: ToolContext, options: JobOptions) => Effect.Effect<ToolResult, ToolError>;
  /** The bot's jobs running now, oldest first. */
  readonly running: (bot: number) => JobView[];
  readonly count: (bot: number) => number;
  /** A running job of this bot, or why there isn't one. */
  readonly find: (bot: number, id: number) => Effect.Effect<{ live: JobView } | { ended: JobRow | undefined }>;
  /** The output the job reported last, if its tool reports progress. */
  readonly output: (id: number) => string | undefined;
  /** Wait up to `ms` for a job; its result if it ended meanwhile (and then no message is sent about it). */
  readonly wait: (id: number, ms: number, signal?: AbortSignal) => Effect.Effect<Outcome | undefined>;
  /** Stop a job and give it a moment to wind down; what it came to, if it did. */
  readonly stop: (id: number) => Effect.Effect<Outcome | undefined>;
  /** Stop all of a bot's jobs without reporting them: the user stopped the bot, or deleted it. */
  readonly stopAll: (bot: number) => Effect.Effect<void>;
  /**
   * At startup, before the bots start: jobs the last process was running were lost with it. Each bot
   * is told (its next task starts with the message), so it can check what happened and run it again.
   * `toolOf` finds a job's tool, for what it says about calls cut off (`TopTool.cutOff`).
   */
  readonly recover: (toolOf: (bot: number, name: string) => TopTool | undefined) => Effect.Effect<number>;
};

/** The daemon's background jobs. Calls run in the scope this is made in, so they outlive the task that started them. */
export const makeJobs = Effect.fnUntraced(function* (events: JobsEvents, foregroundMs: number, repeatGapMs = REPEAT_GAP_MS) {
  const store = yield* Store;
  const scope = yield* Effect.scope;
  const live = new Map<number, Live>();
  const now = Clock.currentTimeMillis;

  const end = Effect.fnUntraced(function* (job: Live, outcome: Outcome) {
    live.delete(job.id);
    const ran = duration((yield* now) - job.startedAt) + (job.runs.count > 1 ? ` and ${job.runs.count} runs` : "");
    if (job.timedOut && !job.stopping) {
      // It ran past the time the bot allowed: it hears so, with what the job had done.
      const head = `[Background job ${job.id} timed out] ${label(job)}: stopped after ${ran}, the time you allowed it`;
      const row = yield* store.endJob(job.id, "stopped", `${head}\n\n${outcomeText(outcome).text}`);
      if (row) yield* events.deliver(row);
    } else if (job.stopping || job.waiters > 0) {
      // Stopped by the bot or the user, or its result went to a `wait`: nobody needs a message about it.
      yield* store.endJob(job.id, job.stopping ? "stopped" : "finished");
    } else {
      const { text: body, failed } = outcomeText(outcome);
      const head = `[Background job ${job.id} ${failed ? "failed" : "finished"}] ${label(job)}, after ${ran}`;
      const row = yield* store.endJob(job.id, "finished", `${head}\n\n${body}`);
      if (row) yield* events.deliver(row);
    }
    yield* events.changed(job.bot);
  });

  const run = Effect.fn("Jobs.run")(function* (tool: TopTool, args: ToolArguments, ctx: ToolContext, options: JobOptions) {
    // The call gets its own signal: the task's stops it only while the task is waiting on it.
    const controller = new AbortController();
    const forward = () => controller.abort();
    if (ctx.signal?.aborted) controller.abort();
    else ctx.signal?.addEventListener("abort", forward, { once: true });
    const unforward = Effect.sync(() => ctx.signal?.removeEventListener("abort", forward));

    const startedAt = yield* now;
    const progress: { latest?: ToolResult } = {};
    const timing: { job: Live | undefined; timedOut: boolean } = { job: undefined, timedOut: false };
    const outcome = yield* Deferred.make<Outcome>();
    const runs = { count: 0 };
    const once = tool
      .run(args, {
        ...ctx,
        signal: controller.signal,
        onUpdate: (partial) => {
          progress.latest = partial;
          ctx.onUpdate?.(partial);
        },
      })
      .pipe(Effect.exit, Effect.map(outcomeOf));
    const repeatWhile = options.repeatWhile;
    /** A result that means "not yet": run the call again instead of reporting it. */
    const again = (result: Outcome) =>
      repeatWhile !== undefined && result.ok && result.result.isError !== true && !controller.signal.aborted && resultText(result.result).includes(repeatWhile);
    const call = Effect.gen(function* () {
      for (;;) {
        const began = yield* now;
        runs.count++;
        const result = yield* once;
        if (!again(result)) return yield* Deferred.succeed(outcome, result);
        // `jobs output` shows the last "not yet".
        if (result.ok) progress.latest = result.result;
        const gap = repeatGapMs - ((yield* now) - began);
        if (gap > 0 && (yield* Effect.result(sleep(gap, controller.signal)))._tag === "Failure")
          // Stopped between runs: what it last came to is the outcome.
          return yield* Deferred.succeed(outcome, result);
      }
    });
    // The call runs in the jobs' scope, not the task's: it may outlive this tool call.
    const stopAfterMs = options.stopAfterMs ?? (repeatWhile === undefined ? undefined : REPEAT_LIMIT_MS);
    const deadline =
      stopAfterMs === undefined
        ? Effect.void
        : Effect.sleep(Duration.millis(stopAfterMs)).pipe(
            Effect.andThen(
              Effect.sync(() => {
                timing.timedOut = true;
                if (timing.job) timing.job.timedOut = true;
                controller.abort();
              }),
            ),
          );
    yield* Effect.forkIn(Effect.raceFirst(Effect.andThen(Deferred.await(outcome), Effect.void), deadline.pipe(Effect.andThen(Effect.never))), scope);
    yield* Effect.forkIn(call, scope);

    const waitMs = options.foregroundMs > 0 ? options.foregroundMs : STARTUP_GRACE_MS;
    const first = yield* Deferred.await(outcome).pipe(Effect.timeoutOption(Duration.millis(waitMs)));
    yield* unforward;
    if (Option.isSome(first)) {
      const result = first.value;
      if (timing.timedOut)
        return yield* new ToolError({
          message: `Stopped after ${duration((yield* now) - startedAt)}: it ran past the time allowed.\n\n${outcomeText(result).text}`,
        });
      if (result.ok) return result.result;
      return yield* ToolError.from(result.error);
    }

    // Still running: hand the task a result now and let the call go on.
    const summary = summarize(args);
    const note = options.note?.trim() ?? "";
    const id = yield* store.startJob(ctx.bot, ctx.key, tool.name, summary, note, startedAt);
    const job: Live = {
      id,
      bot: ctx.bot,
      tool: tool.name,
      summary,
      note,
      startedAt,
      controller,
      outcome,
      progress,
      waiters: 0,
      stopping: false,
      timedOut: timing.timedOut,
      runs,
    };
    timing.job = job;
    live.set(id, job);
    yield* Effect.forkIn(
      Effect.flatMap(Deferred.await(outcome), (result) => end(job, result)),
      scope,
    );
    yield* events.changed(ctx.bot);
    const started =
      options.foregroundMs > 0
        ? `Still running after ${duration(options.foregroundMs)}, so it moved to the background as job ${id}`
        : `Started as background job ${id}`;
    const limit = stopAfterMs === undefined ? "" : ` It will be stopped if it's still running ${duration(stopAfterMs)} after it started.`;
    const repeats =
      repeatWhile === undefined
        ? ""
        : ` While its result contains ${JSON.stringify(repeatWhile)}, it runs again without telling you; you hear once, when it doesn't.`;
    return text(
      `${started} and keeps running.${repeats}${limit} ` +
        "Its result will come to you as a message when it ends, so don't wait or check on it: carry on, or end your turn if there's nothing else to do. " +
        "To see its output so far, wait for it, or stop it, use collar__jobs.",
    );
  });

  const view = (job: Live): JobView => ({ id: job.id, tool: job.tool, summary: job.summary, note: job.note, startedAt: job.startedAt });

  const jobs: Jobs = {
    foregroundMs,
    wrap: (tool) => {
      if (tool.background === false || !(foregroundMs > 0)) return tool;
      return { ...tool, run: (args, ctx) => run(tool, args, ctx, { foregroundMs }) };
    },
    run,
    running: (bot) => [...live.values()].filter((job) => job.bot === bot).map(view),
    count: (bot) => {
      let n = 0;
      for (const job of live.values()) if (job.bot === bot) n++;
      return n;
    },
    find: Effect.fn("Jobs.find")(function* (bot, id) {
      const job = live.get(id);
      if (job && job.bot === bot) return { live: view(job) };
      const row = yield* store.job(id);
      return { ended: row && row.bot === bot ? row : undefined };
    }),
    output: (id) => {
      const latest = live.get(id)?.progress.latest;
      return latest ? resultText(latest) : undefined;
    },
    wait: (id, ms, signal) =>
      Effect.suspend(() => {
        const job = live.get(id);
        if (!job) return Effect.undefined;
        job.waiters++;
        return Deferred.await(job.outcome).pipe(
          Effect.timeoutOption(Duration.millis(ms)),
          Effect.map(Option.getOrUndefined),
          (waiting) => Effect.raceFirst(waiting, Effect.as(Effect.ignore(stopped(signal)), undefined)),
          Effect.ensuring(Effect.sync(() => job.waiters--)),
        );
      }),
    stop: Effect.fn("Jobs.stop")(function* (id) {
      const job = live.get(id);
      if (!job) return undefined;
      job.stopping = true;
      job.controller.abort();
      const result = Option.getOrUndefined(yield* Deferred.await(job.outcome).pipe(Effect.timeoutOption(Duration.millis(STOP_GRACE_MS))));
      // A tool that ignores its signal is let go: it's no longer the bot's job.
      if (!result && live.delete(id)) {
        yield* store.endJob(id, "stopped");
        yield* events.changed(job.bot);
      }
      return result;
    }),
    stopAll: (bot) =>
      Effect.sync(() => {
        for (const job of [...live.values()]) {
          if (job.bot !== bot) continue;
          job.stopping = true;
          job.controller.abort();
        }
      }),
    recover: (toolOf) =>
      Effect.withSpan(
        Effect.gen(function* () {
          const lost = yield* store.runningJobs;
          const at = yield* now;
          for (const job of lost) {
            const head = `[Background job ${job.id} was cut off] ${label(job)}: the daemon restarted while it ran in the background, ${duration(at - job.startedAt)} after it started`;
            const cutOff = toolOf(job.bot, job.tool)?.cutOff;
            yield* store.endJob(
              job.id,
              "lost",
              `${head}, so its result is lost. It may have taken effect, fully or partly.${cutOff ? ` ${cutOff}` : ""} Check before running it again.`,
            );
          }
          return lost.length;
        }),
        "Jobs.recover",
      ),
  };
  return jobs;
});
