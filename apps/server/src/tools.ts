/**
 * Tools, and what is safe to do with one that a daemon restart cut off.
 *
 * Every tool call is recorded before it runs. After a crash, a call without a result is settled by
 * the tool's policy, never by running it again blindly:
 *
 * - `replay: "safe"` (reads, checks): it runs again.
 * - `recover()`: the tool looks up its own outcome by `ctx.key` (for example an email provider's
 *   idempotency key) and reports what really happened.
 * - otherwise: the model is told it was interrupted and may have taken effect, and decides.
 *
 * `ctx.key` is stable for one call across restarts; pass it to outside services as an idempotency key.
 */
import { dirname, join } from "node:path";
import { type ImageContent, type JsonValue, type TextContent, type ToolCall, type Usage, validateToolArguments } from "@earendil-works/pi-ai";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import Type, { type Static, type TProperties, type TSchema } from "typebox";

export type ToolContext = {
  /** Stable for this one tool call, also across restarts. */
  readonly key: string;
  readonly bot: number;
  /**
   * Stop asked for (the user's Stop, a job's time limit). Tools stop cooperatively: they wind down and
   * report what they got to, which is why this is a signal and not an interruption.
   */
  readonly signal?: AbortSignal | undefined;
  /** Output so far, for a tool that reports progress (bash does). Shown when someone asks a background job for it. */
  readonly onUpdate?: ((partial: ToolResult) => void) | undefined;
};

/** What a tool call comes to: `content` goes to the model, `details` to clients. */
export type ToolResult = {
  readonly content: (TextContent | ImageContent)[];
  readonly details: JsonValue | undefined;
  readonly structuredContent?: JsonValue;
  readonly usage?: Usage;
  /** A failure reported without failing: the model sees it as an error result. */
  readonly isError?: boolean;
  /** Every call of a batch saying so ends the task after it, without asking the model again. */
  readonly terminate?: boolean;
};

/** A tool call that failed; the model is told `message`. */
export class ToolError extends Schema.TaggedError<ToolError>()("ToolError", { message: Schema.String }) {
  /** Whatever a tool threw, as a `ToolError` (a `ToolError` stays itself). */
  static from(error: unknown): ToolError {
    if (isToolError(error)) return error;
    return new ToolError({ message: error instanceof Error ? error.message : String(error) });
  }
}

export const isToolError = Schema.is(ToolError);

/**
 * A tool. `P` is the JSON Schema of its arguments (a TypeBox `Type.Object(…)`; an MCP server's schema is
 * a `Type.Unsafe`). Every call is checked against it first (`checkArguments`), so `run` and `recover`
 * get `Static<P>`. Lists of tools hold `TopTool` (any arguments); make one with `defineTool`.
 */
export interface TopTool<P extends TSchema & object = TSchema & object> {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly parameters: P;
  readonly replay?: "never" | "safe";
  /** Normalizes raw arguments before schema validation (pi's tools accept older argument shapes). */
  readonly prepareArguments?: (args: unknown) => Static<P>;
  readonly executionMode?: "sequential" | "parallel";
  /**
   * `false`: never moved to the background, however long it takes (see jobs.ts). For tools that
   * wait on purpose, like Collar's `jobs` waiting for a job.
   */
  readonly background?: false;
  /**
   * What else the model should know about a call that a daemon restart cut off, after "it may have
   * taken effect" (bash: its command may still be running). Said whether it ran in the task or the background.
   */
  readonly cutOff?: string;
  // Methods, not properties, so a TopTool<P> is a TopTool: the arguments it gets were checked against `parameters`.
  run(args: ArgumentsOf<P>, ctx: ToolContext): Effect.Effect<ToolResult, ToolError>;
  /** After a restart cut this call off: its result if it took effect, `false` if it surely did not, `undefined` if unknown. */
  recover?(args: ArgumentsOf<P>, ctx: ToolContext): Effect.Effect<ToolResult | false | undefined>;
}

/** Checked arguments: an object (`checkArguments` makes sure), of the shape `P` describes. */
export type ToolArguments = Readonly<Record<string, unknown>>;
type ArgumentsOf<P extends TSchema> = Static<P> & ToolArguments;

/** A tool, with `run` and `recover` typed by its parameters. */
export const defineTool = <P extends TSchema & object>(tool: TopTool<P>): TopTool => tool;

/**
 * A call's raw arguments, prepared and checked against the tool's parameters (coerced as pi does:
 * `"42"` for a number, …). Throws with what's wrong, for the model to read; also when the model's
 * arguments weren't JSON at all (`argumentsError`).
 */
export function checkArguments(tool: TopTool, call: Pick<ToolCall, "id" | "argumentsError">, raw: unknown): ToolArguments {
  const prepared = jsonObject(tool.prepareArguments ? tool.prepareArguments(raw) : raw);
  if (!prepared) throw new Error(`The arguments of ${tool.name} must be an object.`);
  const { name, description, parameters } = tool;
  const checked = jsonObject(validateToolArguments({ name, description, parameters }, { ...call, type: "toolCall", name, arguments: prepared }));
  if (!checked) throw new Error(`The arguments of ${tool.name} must be an object.`);
  return checked;
}

/** `value` if it's a plain object. Arguments are parsed from the model's JSON, so its values are JSON. */
function jsonObject(value: unknown): { [key: string]: JsonValue } | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as { [key: string]: JsonValue }) : undefined;
}

/** One line of the fake tools' effects log. */
const effectLine = Schema.decodeSync(Schema.fromJsonString(Schema.Struct({ tool: Schema.String, phase: Schema.String, key: Schema.String })));

export const text = (value: string): ToolResult => ({ content: [{ type: "text", text: value }], details: {} });

/** A tool whose work is a Promise (pi's tools, MCP calls): what it throws becomes a `ToolError`. */
export const fromPromise = (run: () => PromiseLike<ToolResult>): Effect.Effect<ToolResult, ToolError> => Effect.tryPromise({ try: run, catch: ToolError.from });

/** Fails with "Stopped" once `signal` is aborted; never ends otherwise. */
export const stopped = (signal: AbortSignal | undefined): Effect.Effect<never, ToolError> =>
  signal === undefined
    ? Effect.never
    : Effect.callback<never, ToolError>((resume) => {
        const stop = () => resume(Effect.fail(new ToolError({ message: "Stopped" })));
        if (signal.aborted) return stop();
        signal.addEventListener("abort", stop, { once: true });
        return Effect.sync(() => signal.removeEventListener("abort", stop));
      });

/** Wait, or fail with "Stopped" when `signal` is aborted first. */
export const sleep = (ms: number, signal?: AbortSignal): Effect.Effect<void, ToolError> => Effect.raceFirst(Effect.sleep(Duration.millis(ms)), stopped(signal));

// ── fake tools with real side effects, for development and the crash tests ───────

/** A page and a note with a diagram, for trying the Files panel without a real model. */
const REPORT_HTML = `<!doctype html>
<meta charset="utf-8">
<title>Weekly status</title>
<style>
  :root { color-scheme: light dark; font: 15px/1.5 system-ui, sans-serif; }
  body { max-width: 40rem; margin: 2rem auto; padding: 0 1rem; }
  .bar { height: 1.4rem; border-radius: 4px; background: #d97757; color: white; padding: 0 .5rem; font-size: 12px; line-height: 1.4rem; }
  td { padding: .25rem .75rem .25rem 0; }
</style>
<h1>Weekly status</h1>
<p>Deploys this week, by service. <a href="notes.md">Notes</a></p>
<table>
  <tr><td>web</td><td><div class="bar" style="width: 18rem">12</div></td></tr>
  <tr><td>api</td><td><div class="bar" style="width: 9rem">6</div></td></tr>
  <tr><td>jobs</td><td><div class="bar" style="width: 3rem">2</div></td></tr>
</table>
<p id="clock"></p>
<script>document.getElementById("clock").textContent = "Rendered at " + new Date().toLocaleTimeString();</script>
`;
const REPORT_NOTES = `# Notes

The pipeline, as it stands:

\`\`\`mermaid
flowchart LR
  push[Push] --> ci[CI] --> stage[Staging] --> prod[Production]
  ci -- fails --> fix[Fix]
\`\`\`

| Service | Deploys | p99 |
|---|---|---|
| web | 12 | 41 ms |
| api | 6 | 88 ms |
`;

/**
 * Side effects of the fake tools, one JSON line each, so tests can count what really happened.
 * `filesOf` gives a bot's files folder, for `write_report`.
 */
export const makeFakeTools = Effect.fnUntraced(function* (
  effectsPath: string,
  filesOf: (bot: number) => Effect.Effect<string | undefined> = () => Effect.undefined,
) {
  const fs = yield* FileSystem.FileSystem;
  const record = (tool: string, phase: string, key: string, detail?: unknown) =>
    Effect.flatMap(Clock.currentTimeMillis, (at) =>
      Effect.orDie(fs.writeFileString(effectsPath, `${JSON.stringify({ tool, phase, key, detail, at })}\n`, { flag: "a" })),
    );
  const recorded = (tool: string, phase: string, key: string) =>
    fs.readFileString(effectsPath).pipe(
      Effect.map((text) =>
        text
          .split("\n")
          .filter(Boolean)
          .some((line) => {
            const e = effectLine(line);
            return e.tool === tool && e.phase === phase && e.key === key;
          }),
      ),
      Effect.orElseSucceed(() => false),
    );
  const seconds = (args: { readonly seconds?: number }, fallback: number) => Math.max(0, args.seconds ?? fallback) * 1_000;
  const schema = <P extends TProperties>(properties: P) => Type.Object(properties, { additionalProperties: false });
  const { Optional, String: Str, Number: Num } = Type;

  return [
    defineTool({
      // Takes effect at once, then takes a while to report. Cannot check its outcome: a restart in
      // between leaves it "interrupted, may have taken effect".
      name: "deploy",
      label: "Deploy",
      description: "Deploy a service. Takes effect immediately.",
      parameters: schema({ service: Optional(Str()), seconds: Optional(Num()) }),
      run: (args, ctx) =>
        Effect.gen(function* () {
          yield* record("deploy", "effect", ctx.key, args.service);
          yield* sleep(seconds(args, 2), ctx.signal);
          return text(`Deployed ${args.service ?? "the service"}.`);
        }),
    }),
    defineTool({
      // Sends, then waits for the provider's receipt. Its provider dedupes by key, so after a restart
      // it can look up whether the send happened.
      name: "send_email",
      label: "Send email",
      description: "Send an email.",
      parameters: schema({ to: Optional(Str()), subject: Optional(Str()), seconds: Optional(Num()) }),
      run: (args, ctx) =>
        Effect.gen(function* () {
          if (!(yield* recorded("send_email", "effect", ctx.key))) yield* record("send_email", "effect", ctx.key, args.to);
          yield* sleep(seconds(args, 2), ctx.signal);
          return text(`Sent “${args.subject ?? ""}” to ${args.to ?? ""}.`);
        }),
      recover: (args, ctx) =>
        Effect.map(recorded("send_email", "effect", ctx.key), (sent) =>
          sent ? text(`Sent “${args.subject ?? ""}” to ${args.to ?? ""} (confirmed after a restart).`) : false,
        ),
    }),
    defineTool({
      // Read-only, so a restart just runs it again.
      name: "check_status",
      label: "Check status",
      description: "Check the status of a system. Read-only.",
      parameters: schema({ target: Optional(Str()), seconds: Optional(Num()) }),
      replay: "safe",
      run: (args, ctx) =>
        Effect.gen(function* () {
          yield* record("check_status", "start", ctx.key, args.target);
          yield* sleep(seconds(args, 1), ctx.signal);
          return text(`${args.target ?? "Everything"} is healthy. Queue depth 0, p99 41 ms.`);
        }),
    }),
    defineTool({
      // Writes the same files again, so a restart may run it again.
      name: "write_report",
      label: "Write report",
      description: "Write a status report (a page and a note) to the bot's files folder.",
      parameters: schema({}),
      replay: "safe",
      run: (_args, ctx) =>
        Effect.gen(function* () {
          const folder = yield* filesOf(ctx.bot);
          if (!folder) return text("This bot has no files folder.");
          for (const [name, content] of [
            ["report.html", REPORT_HTML],
            ["notes.md", REPORT_NOTES],
          ] as const) {
            const path = join(folder, name);
            yield* fs
              .makeDirectory(dirname(path), { recursive: true })
              .pipe(Effect.andThen(fs.writeFileString(path, content)), Effect.mapError(ToolError.from));
          }
          yield* record("write_report", "effect", ctx.key);
          return text("Wrote files/report.html and files/notes.md.");
        }),
    }),
    defineTool({
      // Kills the daemon every time it runs, to test that a crash loop ends.
      name: "crash_daemon",
      label: "Crash the daemon",
      description: "Testing only: kills the daemon process.",
      parameters: schema({}),
      replay: "safe",
      run: (_args, ctx) =>
        Effect.gen(function* () {
          yield* record("crash_daemon", "start", ctx.key);
          yield* Effect.sync(() => process.kill(process.pid, "SIGKILL"));
          return yield* Effect.never;
        }),
    }),
  ];
});
