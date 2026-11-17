import { dirname, join } from "node:path";
import { type ImageContent, type JsonValue, type TextContent, type ToolCall, type Usage, validateToolArguments } from "@earendil-works/pi-ai";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import Type, { type Static, type TProperties, type TSchema } from "typebox";

export type ToolContext = {
  readonly key: string;
  readonly bot: number;
  readonly signal?: AbortSignal | undefined;
  readonly onUpdate?: ((partial: ToolResult) => void) | undefined;
};

export type ToolResult = {
  readonly content: (TextContent | ImageContent)[];
  readonly details: JsonValue | undefined;
  readonly structuredContent?: JsonValue;
  readonly usage?: Usage;
  readonly isError?: boolean;
  readonly terminate?: boolean;
};

export class ToolError extends Schema.TaggedError<ToolError>()("ToolError", { message: Schema.String }) {
  static from(error: unknown): ToolError {
    if (isToolError(error)) return error;
    return new ToolError({ message: error instanceof Error ? error.message : String(error) });
  }
}

export const isToolError = Schema.is(ToolError);

export interface TopTool<P extends TSchema & object = TSchema & object> {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly parameters: P;
  readonly replay?: "never" | "safe";
  readonly prepareArguments?: (args: unknown) => Static<P>;
  readonly executionMode?: "sequential" | "parallel";
  readonly background?: false;
  readonly cutOff?: string;
  run(args: ArgumentsOf<P>, ctx: ToolContext): Effect.Effect<ToolResult, ToolError>;
  recover?(args: ArgumentsOf<P>, ctx: ToolContext): Effect.Effect<ToolResult | false | undefined>;
}

export type ToolArguments = Readonly<Record<string, unknown>>;
type ArgumentsOf<P extends TSchema> = Static<P> & ToolArguments;

export const defineTool = <P extends TSchema & object>(tool: TopTool<P>): TopTool => tool;

export function checkArguments(tool: TopTool, call: Pick<ToolCall, "id" | "argumentsError">, raw: unknown): ToolArguments {
  const prepared = jsonObject(tool.prepareArguments ? tool.prepareArguments(raw) : raw);
  if (!prepared) throw new Error(`The arguments of ${tool.name} must be an object.`);
  const { name, description, parameters } = tool;
  const checked = jsonObject(validateToolArguments({ name, description, parameters }, { ...call, type: "toolCall", name, arguments: prepared }));
  if (!checked) throw new Error(`The arguments of ${tool.name} must be an object.`);
  return checked;
}

function jsonObject(value: unknown): { [key: string]: JsonValue } | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as { [key: string]: JsonValue }) : undefined;
}

const effectLine = Schema.decodeSync(Schema.fromJsonString(Schema.Struct({ tool: Schema.String, phase: Schema.String, key: Schema.String })));

export const text = (value: string): ToolResult => ({ content: [{ type: "text", text: value }], details: {} });

export const fromPromise = (run: () => PromiseLike<ToolResult>): Effect.Effect<ToolResult, ToolError> => Effect.tryPromise({ try: run, catch: ToolError.from });

export const stopped = (signal: AbortSignal | undefined): Effect.Effect<never, ToolError> =>
  signal === undefined
    ? Effect.never
    : Effect.callback<never, ToolError>((resume) => {
        const stop = () => resume(Effect.fail(new ToolError({ message: "Stopped" })));
        if (signal.aborted) return stop();
        signal.addEventListener("abort", stop, { once: true });
        return Effect.sync(() => signal.removeEventListener("abort", stop));
      });

export const sleep = (ms: number, signal?: AbortSignal): Effect.Effect<void, ToolError> => Effect.raceFirst(Effect.sleep(Duration.millis(ms)), stopped(signal));

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
