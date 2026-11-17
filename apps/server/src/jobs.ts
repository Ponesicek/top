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

export const ForegroundMs = Config.Int("TOP_TOOL_FOREGROUND_MS").pipe(Config.withDefault(30_000));
const STARTUP_GRACE_MS = 1_000;
const RESULT_CHARS = 30_000;
const STOP_GRACE_MS = 5_000;
export const REPEAT_GAP_MS = 30_000;
export const REPEAT_LIMIT_MS = 24 * 60 * 60 * 1000;

export type Outcome = { readonly ok: true; readonly result: ToolResult } | { readonly ok: false; readonly error: unknown };

type Live = {
  readonly id: number;
  readonly bot: number;
  readonly tool: string;
  readonly summary: string;
  readonly startedAt: number;
  readonly controller: AbortController;
  readonly outcome: Deferred.Deferred<Outcome>;
  readonly progress: { latest?: ToolResult };
  readonly note: string;
  waiters: number;
  stopping: boolean;
  timedOut: boolean;
  readonly runs: { count: number };
};

export type JobView = { readonly id: number; readonly tool: string; readonly summary: string; readonly note: string; readonly startedAt: number };

export type JobOptions = {
  readonly foregroundMs: number;
  readonly stopAfterMs?: number;
  readonly note?: string;
  readonly repeatWhile?: string;
};

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
  readonly deliver: (row: InboxRow) => Effect.Effect<void>;
  readonly changed: (bot: number) => Effect.Effect<void>;
};

export type Jobs = {
  readonly foregroundMs: number;
  readonly wrap: (tool: TopTool) => TopTool;
  readonly run: (tool: TopTool, args: ToolArguments, ctx: ToolContext, options: JobOptions) => Effect.Effect<ToolResult, ToolError>;
  readonly running: (bot: number) => JobView[];
  readonly count: (bot: number) => number;
  readonly find: (bot: number, id: number) => Effect.Effect<{ live: JobView } | { ended: JobRow | undefined }>;
  readonly output: (id: number) => string | undefined;
  readonly wait: (id: number, ms: number, signal?: AbortSignal) => Effect.Effect<Outcome | undefined>;
  readonly stop: (id: number) => Effect.Effect<Outcome | undefined>;
  readonly stopAll: (bot: number) => Effect.Effect<void>;
  readonly recover: (toolOf: (bot: number, name: string) => TopTool | undefined) => Effect.Effect<number>;
};

export const makeJobs = Effect.fnUntraced(function* (events: JobsEvents, foregroundMs: number, repeatGapMs = REPEAT_GAP_MS) {
  const store = yield* Store;
  const scope = yield* Effect.scope;
  const live = new Map<number, Live>();
  const now = Clock.currentTimeMillis;

  const end = Effect.fnUntraced(function* (job: Live, outcome: Outcome) {
    live.delete(job.id);
    const ran = duration((yield* now) - job.startedAt) + (job.runs.count > 1 ? ` and ${job.runs.count} runs` : "");
    if (job.timedOut && !job.stopping) {
      const head = `[Background job ${job.id} timed out] ${label(job)}: stopped after ${ran}, the time you allowed it`;
      const row = yield* store.endJob(job.id, "stopped", `${head}\n\n${outcomeText(outcome).text}`);
      if (row) yield* events.deliver(row);
    } else if (job.stopping || job.waiters > 0) {
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
    const again = (result: Outcome) =>
      repeatWhile !== undefined && result.ok && result.result.isError !== true && !controller.signal.aborted && resultText(result.result).includes(repeatWhile);
    const call = Effect.gen(function* () {
      for (;;) {
        const began = yield* now;
        runs.count++;
        const result = yield* once;
        if (!again(result)) return yield* Deferred.succeed(outcome, result);
        if (result.ok) progress.latest = result.result;
        const gap = repeatGapMs - ((yield* now) - began);
        if (gap > 0 && (yield* Effect.result(sleep(gap, controller.signal)))._tag === "Failure") return yield* Deferred.succeed(outcome, result);
      }
    });
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
