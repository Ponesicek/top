import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import Type from "typebox";
import { outcomeText } from "../jobs.ts";
import type { JobState } from "../store.ts";
import { duration } from "../time.ts";
import { defineTool, type ToolResult, text } from "../tools.ts";
import type { CollarGroup } from "./index.ts";

const parameters = Type.Object(
  {
    action: Type.Enum(["list", "output", "wait", "stop"]),
    id: Type.Optional(Type.Integer({ description: "output, wait, stop: the job's number." })),
    seconds: Type.Optional(Type.Number({ description: "wait: the longest to wait. Capped at the tool time limit." })),
  },
  { additionalProperties: false },
);

const failed = (value: string): ToolResult => ({ ...text(value), isError: true });

const HOW_IT_ENDED: Record<Exclude<JobState, "running">, string> = {
  finished: "finished; its result was sent to you as a message",
  stopped: "was stopped",
  lost: "was cut off by a daemon restart",
};

export const jobsGroup: CollarGroup = (daemon) => [
  defineTool({
    name: "jobs",
    label: "Background jobs",
    description: [
      "Your tool calls that ran past the time limit and moved to the background, where they keep running.",
      "You don't need this to get a job's result: it comes to you as a message when the job ends.",
      'Use `action: "list"` to see them, "output" for what a job has printed so far, "wait" to wait for one a while longer when you can\'t go on without it, and "stop" to end one.',
    ].join(" "),
    parameters,
    replay: "safe",
    background: false,
    run: (args, ctx) =>
      Effect.gen(function* () {
        const jobs = daemon.jobs;
        const action = args.action;
        const now = yield* Clock.currentTimeMillis;
        if (action === "list") {
          const running = jobs.running(ctx.bot);
          if (!running.length) return text("No background jobs are running.");
          return text(
            running
              .map((j) => `- ${j.id}: ${j.note ? `${j.note}: ` : ""}${j.tool}${j.summary ? ` (${j.summary})` : ""}, running for ${duration(now - j.startedAt)}`)
              .join("\n"),
          );
        }

        const id = args.id;
        if (id === undefined) return failed('Say which job with `id` (see `action: "list"`).');
        const found = yield* jobs.find(ctx.bot, id);
        if ("ended" in found) {
          if (!found.ended) return failed(`You have no job ${id}.`);
          const { state } = found.ended;
          return text(`Job ${id} is no longer running: it ${state === "running" ? "ended" : HOW_IT_ENDED[state]}.`);
        }

        switch (action) {
          case "output": {
            const output = jobs.output(id);
            return text(
              output === undefined
                ? `Job ${id} has been running for ${duration(now - found.live.startedAt)}. Its tool doesn't report output while it runs.`
                : `Job ${id}, running for ${duration(now - found.live.startedAt)}. Output so far:\n\n${output || "(none yet)"}`,
            );
          }
          case "wait": {
            const limit = jobs.foregroundMs;
            const ms = Math.min(Math.max(0, (args.seconds ?? limit / 1000) * 1000), limit);
            const outcome = yield* jobs.wait(id, ms, ctx.signal);
            if (!outcome)
              return text(
                `Job ${id} is still running after ${duration((yield* Clock.currentTimeMillis) - found.live.startedAt)}. Its result will come to you as a message when it ends.`,
              );
            const { text: body, failed: isError } = outcomeText(outcome);
            return { ...text(`Job ${id} ${isError ? "failed" : "finished"}:\n\n${body}`), ...(isError ? { isError: true } : {}) };
          }
          case "stop": {
            const outcome = yield* jobs.stop(id);
            return text(outcome ? `Stopped job ${id}. What it came to:\n\n${outcomeText(outcome).text}` : `Stopped job ${id}.`);
          }
          default:
            return failed(`Unknown action "${action}".`);
        }
      }),
  }),
];
