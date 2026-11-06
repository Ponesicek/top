/**
 * `collar__background`: run any of the bot's tools as a background job, choosing how long to wait
 * for it and when to give up (see jobs.ts). It's how a bot runs several slow things at once (other
 * agents over MCP, builds, long commands) and hears back from each as it ends.
 */
import { validateToolArguments } from "@earendil-works/pi-ai";
import Type from "typebox";
import { duration } from "../time.ts";
import { type ToolResult, text } from "../tools.ts";
import type { CollarGroup } from "./index.ts";

/** The longest a bot may keep its task waiting on one call: past this, it should let it go and end its turn. */
const MAX_WAIT_MS = 30 * 60 * 1000;
const MAX_STOP_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

const parameters = Type.Object(
  {
    tool: Type.String({ description: "The tool to run, by its full name (e.g. an MCP tool such as github__create_issue, or bash)." }),
    arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Its arguments, as you'd pass them calling it directly." })),
    wait_seconds: Type.Optional(
      Type.Number({
        description: `How long to wait for it before it goes on in the background. Default 0: start it and carry on (it still gets a second, so a call that fails at once answers here). If it ends sooner you get its result here, like a direct call. At most ${MAX_WAIT_MS / 60_000} minutes.`,
      }),
    ),
    stop_after_minutes: Type.Optional(
      Type.Number({ description: "Stop it if it's still running this many minutes after it started; you're told it timed out. Default: no limit." }),
    ),
    note: Type.Optional(
      Type.String({
        description: 'What it\'s for, in a few words ("review of PR 12"). It heads the message you get when it ends, so you can tell your jobs apart.',
      }),
    ),
  },
  { additionalProperties: false },
);

const failed = (value: string): ToolResult => ({ ...text(value), isError: true });

export const backgroundGroup: CollarGroup = (daemon) => [
  {
    name: "background",
    label: "Run in the background",
    description: [
      "Run one of your tools as a background job: start it, then do other work or end your turn. Its result comes to you as a message when it ends, even when you're idle, so you never need to poll.",
      "Use it to run several slow things at once, such as other agents you delegate to, builds or long commands, and to set how long to wait (`wait_seconds`) and when to give up (`stop_after_minutes`).",
      "Start each job in its own call; one message can hold several. Calling a tool directly works too: a call still running after the time limit moves to the background by itself, but this one lets you decide.",
      "See, wait for or stop jobs with collar__jobs.",
    ].join(" "),
    parameters,
    // It only starts the call; whether that one may run again is its own tool's business, so never replay.
    background: false,
    async run(args, ctx) {
      const name = String(args.tool ?? "");
      const tool = daemon.toolsOf(ctx.bot).find((t) => t.name === name);
      if (!tool) return failed(`You have no tool named "${name}".`);
      if (tool.background === false) return failed(`${name} can't run in the background.`);

      let callArgs: Record<string, unknown>;
      try {
        const raw = (args.arguments ?? {}) as Record<string, unknown>;
        const prepared = tool.prepareArguments ? tool.prepareArguments(raw) : raw;
        callArgs = validateToolArguments(
          { name, description: tool.description, parameters: tool.parameters } as never,
          {
            type: "toolCall",
            id: ctx.key,
            name,
            arguments: prepared,
          } as never,
        ) as Record<string, unknown>;
      } catch (error) {
        return failed(error instanceof Error ? error.message : String(error));
      }

      const waitMs = Math.min(Math.max(0, Number(args.wait_seconds ?? 0) * 1000 || 0), MAX_WAIT_MS);
      let stopAfterMs: number | undefined;
      if (args.stop_after_minutes !== undefined) {
        stopAfterMs = Number(args.stop_after_minutes) * 60_000;
        if (!(stopAfterMs > 0)) return failed("`stop_after_minutes` must be more than 0.");
        if (stopAfterMs > MAX_STOP_AFTER_MS) return failed(`\`stop_after_minutes\` can be at most ${duration(MAX_STOP_AFTER_MS)}.`);
      }
      const note = typeof args.note === "string" ? args.note.slice(0, 200) : undefined;
      // The call to `background` is the job's call: its key names the job.
      return daemon.jobs.run(tool, callArgs, ctx, {
        foregroundMs: waitMs,
        ...(stopAfterMs !== undefined ? { stopAfterMs } : {}),
        ...(note ? { note } : {}),
      });
    },
  },
];
