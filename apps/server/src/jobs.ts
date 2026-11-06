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
 */
import type { InboxRow, JobRow, Store } from "./store.ts";
import { duration } from "./time.ts";
import { type ToolContext, type ToolResult, type TopTool, text } from "./tools.ts";
import { summarize } from "./wire.ts";

/** How long a tool call may keep a task waiting before it moves to the background. */
export const FOREGROUND_MS = Number(process.env.TOP_TOOL_FOREGROUND_MS ?? 30_000);
/**
 * A call started straight in the background still gets this long: one that fails at once (a typo in
 * a command, a server that refuses) comes back as its result, not as a job that ends a moment later.
 */
const STARTUP_GRACE_MS = 1_000;
/** The most of a job's result that reaches the model; the end is kept, where a command's outcome is. */
const RESULT_CHARS = 30_000;
/** How long `stop` waits for a stopped job to wind down before answering. */
const STOP_GRACE_MS = 5_000;

type Outcome = { readonly ok: true; readonly result: ToolResult } | { readonly ok: false; readonly error: unknown };

type Live = {
  readonly id: number;
  readonly bot: number;
  readonly tool: string;
  readonly summary: string;
  readonly startedAt: number;
  readonly controller: AbortController;
  readonly outcome: Promise<Outcome>;
  /** The output it reported last, if the tool reports progress. */
  readonly progress: { latest?: ToolResult };
  /** What it's for, in the bot's words (`collar__background`'s `note`). */
  readonly note: string;
  /** `jobs wait` calls waiting on it: while there are any, its result goes to them, not to the inbox. */
  waiters: number;
  stopping: boolean;
  /** It ran past the time the bot allowed and was stopped for that: the bot hears about it. */
  timedOut: boolean;
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

const label = (job: { tool: string; summary: string; note: string }) => {
  const call = job.summary ? `${job.tool} (${job.summary})` : job.tool;
  return job.note ? `${job.note}: ${call}` : call;
};

export type JobsEvents = {
  /** A job's message was queued for its bot. */
  deliver(row: InboxRow): void;
  /** The bot's set of running jobs changed. */
  changed(bot: number): void;
};

export class Jobs {
  readonly #store: Store;
  readonly #events: JobsEvents;
  readonly #foregroundMs: number;
  readonly #live = new Map<number, Live>();

  constructor(store: Store, events: JobsEvents, foregroundMs = FOREGROUND_MS) {
    this.#store = store;
    this.#events = events;
    this.#foregroundMs = foregroundMs;
  }

  get foregroundMs(): number {
    return this.#foregroundMs;
  }

  /** The tool, with calls that outrun the time limit moved to the background. */
  wrap(tool: TopTool): TopTool {
    if (tool.background === false || !(this.#foregroundMs > 0)) return tool;
    return { ...tool, run: (args, ctx) => this.run(tool, args, ctx, { foregroundMs: this.#foregroundMs }) };
  }

  /**
   * Run one call: its result if it ends within `foregroundMs`, else it goes on as a job and the result
   * says so. `ctx.key` names the job, so the same call is never two jobs.
   */
  async run(tool: TopTool, args: Record<string, unknown>, ctx: ToolContext, options: JobOptions): Promise<ToolResult> {
    // The call gets its own signal: the task's stops it only while the task is waiting on it.
    const controller = new AbortController();
    const forward = () => controller.abort();
    if (ctx.signal?.aborted) controller.abort();
    else ctx.signal?.addEventListener("abort", forward, { once: true });

    const startedAt = Date.now();
    const progress: { latest?: ToolResult } = {};
    let job: Live | undefined;
    let timedOut = false;
    const deadline =
      options.stopAfterMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            if (job) job.timedOut = true;
            controller.abort();
          }, options.stopAfterMs);
    const outcome: Promise<Outcome> = tool
      .run(args, {
        ...ctx,
        signal: controller.signal,
        onUpdate: (partial) => {
          progress.latest = partial;
          ctx.onUpdate?.(partial);
        },
      })
      .then(
        (result) => ({ ok: true as const, result }),
        (error: unknown) => ({ ok: false as const, error }),
      )
      .finally(() => clearTimeout(deadline));

    let timer: ReturnType<typeof setTimeout> | undefined;
    const waitMs = options.foregroundMs > 0 ? options.foregroundMs : STARTUP_GRACE_MS;
    const first = await Promise.race([outcome, new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), waitMs)))]);
    clearTimeout(timer);
    if (first) {
      ctx.signal?.removeEventListener("abort", forward);
      if (timedOut) throw new Error(`Stopped after ${duration(Date.now() - startedAt)}: it ran past the time allowed.\n\n${outcomeText(first).text}`);
      if (first.ok) return first.result;
      throw first.error;
    }

    // Still running: hand the task a result now and let the call go on.
    ctx.signal?.removeEventListener("abort", forward);
    const summary = summarize(args);
    const note = options.note?.trim() ?? "";
    const id = this.#store.startJob(ctx.bot, ctx.key, tool.name, summary, note, startedAt);
    const live: Live = { id, bot: ctx.bot, tool: tool.name, summary, note, startedAt, controller, outcome, progress, waiters: 0, stopping: false, timedOut };
    job = live;
    this.#live.set(id, live);
    void outcome.then((result) => this.#end(live, result));
    this.#events.changed(ctx.bot);
    const started =
      options.foregroundMs > 0
        ? `Still running after ${duration(options.foregroundMs)}, so it moved to the background as job ${id}`
        : `Started as background job ${id}`;
    const limit = options.stopAfterMs === undefined ? "" : ` It will be stopped if it's still running ${duration(options.stopAfterMs)} after it started.`;
    return text(
      `${started} and keeps running.${limit} ` +
        "Its result will come to you as a message when it ends, so don't wait or check on it: carry on, or end your turn if there's nothing else to do. " +
        "To see its output so far, wait for it, or stop it, use collar__jobs.",
    );
  }

  #end(job: Live, outcome: Outcome) {
    this.#live.delete(job.id);
    if (job.timedOut && !job.stopping) {
      // It ran past the time the bot allowed: it hears so, with what the job had done.
      const head = `[Background job ${job.id} timed out] ${label(job)}: stopped after ${duration(Date.now() - job.startedAt)}, the time you allowed it`;
      const row = this.#store.endJob(job.id, "stopped", `${head}\n\n${outcomeText(outcome).text}`);
      if (row) this.#events.deliver(row);
    } else if (job.stopping || job.waiters > 0) {
      // Stopped by the bot or the user, or its result went to a `wait`: nobody needs a message about it.
      this.#store.endJob(job.id, job.stopping ? "stopped" : "finished");
    } else {
      const { text: body, failed } = outcomeText(outcome);
      const head = `[Background job ${job.id} ${failed ? "failed" : "finished"}] ${label(job)}, after ${duration(Date.now() - job.startedAt)}`;
      const row = this.#store.endJob(job.id, "finished", `${head}\n\n${body}`);
      if (row) this.#events.deliver(row);
    }
    this.#events.changed(job.bot);
  }

  /** The bot's jobs running now, oldest first. */
  running(bot: number): JobView[] {
    return [...this.#live.values()].filter((job) => job.bot === bot).map(({ id, tool, summary, note, startedAt }) => ({ id, tool, summary, note, startedAt }));
  }

  count(bot: number): number {
    let n = 0;
    for (const job of this.#live.values()) if (job.bot === bot) n++;
    return n;
  }

  /** A running job of this bot, or why there isn't one. */
  find(bot: number, id: number): { live: JobView } | { ended: JobRow | undefined } {
    const job = this.#live.get(id);
    if (job && job.bot === bot) return { live: { id, tool: job.tool, summary: job.summary, note: job.note, startedAt: job.startedAt } };
    const row = this.#store.job(id);
    return { ended: row && row.bot === bot ? row : undefined };
  }

  /** The output the job reported last, if its tool reports progress. */
  output(id: number): string | undefined {
    const latest = this.#live.get(id)?.progress.latest;
    return latest ? resultText(latest) : undefined;
  }

  /** Wait up to `ms` for a job; its result if it ended meanwhile (and then no message is sent about it). */
  async wait(id: number, ms: number, signal?: AbortSignal): Promise<Outcome | undefined> {
    const job = this.#live.get(id);
    if (!job) return undefined;
    job.waiters++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      return await Promise.race([
        job.outcome,
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), ms);
          onAbort = () => resolve(undefined);
          signal?.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
    } finally {
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
      job.waiters--;
    }
  }

  /** Stop a job and give it a moment to wind down; what it came to, if it did. */
  async stop(id: number): Promise<Outcome | undefined> {
    const job = this.#live.get(id);
    if (!job) return undefined;
    job.stopping = true;
    job.controller.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([job.outcome, new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), STOP_GRACE_MS)))]);
    clearTimeout(timer);
    // A tool that ignores its signal is let go: it's no longer the bot's job.
    if (!result && this.#live.delete(id)) {
      this.#store.endJob(id, "stopped");
      this.#events.changed(job.bot);
    }
    return result;
  }

  /** Stop all of a bot's jobs without reporting them: the user stopped the bot, or deleted it. */
  stopAll(bot: number) {
    for (const job of [...this.#live.values()]) {
      if (job.bot !== bot) continue;
      job.stopping = true;
      job.controller.abort();
    }
  }

  /**
   * At startup, before the bots start: jobs the last process was running were lost with it. Each bot
   * is told (its next task starts with the message), so it can check what happened and run it again.
   */
  recover(): number {
    const lost = this.#store.runningJobs();
    for (const job of lost) {
      const command = job.tool === "bash" ? " The command may even still be running." : "";
      this.#store.endJob(
        job.id,
        "lost",
        `[Background job ${job.id} was cut off] ${label(job)}: the daemon restarted while it ran in the background, ${duration(Date.now() - job.startedAt)} after it started, so its result is lost. It may have taken effect, fully or partly.${command} Check before running it again.`,
      );
    }
    return lost.length;
  }
}
