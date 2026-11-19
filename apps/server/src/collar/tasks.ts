import { type TaskError, taskEnded } from "@top/protocol";
import * as Effect from "effect/Effect";
import Type from "typebox";
import { DEFAULT_READ, MAX_READ, type ReadResult, type Snapshot, type Tasks } from "../tasks/coordinator.ts";
import { CAPABILITY_NOTES, type Capabilities } from "../tasks/harness.ts";
import type { TaskInputRow } from "../tasks/store.ts";
import { defineTool, type ToolResult, text } from "../tools.ts";
import type { CollarGroup } from "./index.ts";

const MAX_WAIT_S = 30 * 60;
const DEFAULT_WAIT_S = 60;
const RESULT_IN_READ = 12_000;

const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : undefined);

const json = (value: unknown, details?: { readonly task: string }): ToolResult => ({ ...text(JSON.stringify(value)), details: details ?? {} });

const refused = (error: unknown): ToolResult => ({ ...text(error instanceof Error ? error.message : String(error)), isError: true });

function inputJson(input: TaskInputRow) {
  return {
    request: input.id,
    title: input.title,
    questions: input.questions.map((q) => ({
      id: q.id,
      question: q.question,
      ...(q.header ? { header: q.header } : {}),
      options: q.options.map((o) => o.label),
      ...(q.multiple ? { multiple: true } : {}),
    })),
  };
}

export function taskJson(snapshot: Snapshot, resultChars?: number, resultFrom = 0) {
  const { task, session } = snapshot;
  return {
    id: task.id,
    title: task.title,
    state: task.state,
    harness: session.harness,
    session: session.id,
    cwd: session.cwd,
    ...(session.model ? { model: session.model } : {}),
    created_at: iso(task.createdAt),
    ...(task.startedAt ? { started_at: iso(task.startedAt) } : {}),
    ...(task.endedAt ? { ended_at: iso(task.endedAt) } : {}),
    ...(task.result !== null && resultChars !== undefined
      ? {
          result: task.result.slice(resultFrom, resultFrom + resultChars),
          ...(task.result.length > resultFrom + resultChars ? { result_more_from: resultFrom + resultChars } : {}),
        }
      : {}),
    ...(task.error ? { error: task.error } : {}),
    ...(task.usage ? { usage: task.usage } : {}),
    ...(snapshot.inputs.length ? { waiting_for: snapshot.inputs.map(inputJson) } : {}),
    ...(snapshot.queued ? { queued_messages: snapshot.queued } : {}),
  };
}

const capabilityList = (capabilities: Capabilities) =>
  Object.entries(capabilities)
    .filter(([, on]) => on)
    .map(([name]) => name)
    .join(", ");

function harnessLines(tasks: Tasks): string {
  return tasks.adapters
    .map((a) => {
      const options = Object.entries(a.options.properties)
        .map(([name, schema]) => `${name}${(schema as { description?: string }).description ? ` (${(schema as { description?: string }).description})` : ""}`)
        .join("; ");
      const missing = (Object.keys(a.capabilities) as (keyof Capabilities)[]).filter((k) => !a.capabilities[k]);
      return `- "${a.id}" (${a.label}): can ${capabilityList(a.capabilities) || "nothing extra"}${missing.length ? `; can't ${missing.join(", ")}` : ""}. Options: ${options || "none"}.`;
    })
    .join("\n");
}

const run = <A>(effect: Effect.Effect<A, TaskError>, ok: (value: A) => ToolResult) =>
  effect.pipe(
    Effect.map(ok),
    Effect.catch((error) => Effect.succeed(refused(error))),
  );

const ids = { id: Type.String({ description: "The task's id, from collar__task_start (task_…)." }) };

export const tasksGroup: CollarGroup = (daemon) => {
  const tasks = daemon.tasks;
  if (!tasks?.adapters.length) return [];
  const harnesses = tasks.adapters.map((a) => a.id);
  const capabilityHelp = Object.entries(CAPABILITY_NOTES)
    .map(([name, note]) => `${name}: ${note}`)
    .join("; ");

  return [
    defineTool({
      name: "task_start",
      label: "Start a coding task",
      description: [
        "Hand a coding task to a full coding agent harness on this computer, which works on it in the background with its own tools: read and edit files, run commands, test.",
        "It returns at once with a task id. When the task ends you get a message with its answer, even when you're idle, so don't poll: carry on, or end your turn.",
        "Harnesses here:",
        harnessLines(tasks),
        `Capabilities: ${capabilityHelp}.`,
        "The harness runs with full access, as the user running Top: no sandbox and no approval prompts. Only start work you would do yourself, in the folder it belongs in.",
        "Questions it asks come to you as a message (answer with collar__task_respond) and to the user on a card.",
        "`cwd` defaults to your own folder.",
        "A task is one piece of work in a session. To continue a session later (it keeps the conversation), start a new task with `session`; `fork: true` branches it instead.",
      ].join("\n"),
      parameters: Type.Object(
        {
          harness: Type.Optional(Type.Enum(harnesses, { description: "Which harness runs it. Required unless `session` is given." })),
          prompt: Type.String({ description: "What to do, with everything the harness needs to know: it hasn't seen this conversation." }),
          title: Type.Optional(Type.String({ description: "A few words for the task, shown to the user. Default: the prompt's first line." })),
          cwd: Type.Optional(Type.String({ description: "The folder it works in (absolute, ~/…, or relative to your folder). Default: your folder." })),
          session: Type.Optional(Type.String({ description: "Continue this session (ses_…) from an earlier task, with its conversation." })),
          fork: Type.Optional(Type.Boolean({ description: "With `session`: branch it into a new session instead of continuing it." })),
          model: Type.Optional(Type.String({ description: "The model, by the harness's own name for it. Default: the harness's." })),
          options: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Harness-specific options, listed above." })),
          images: Type.Optional(Type.Array(Type.String(), { description: "Image files (PNG, JPEG, GIF, WebP) to give it with the prompt." })),
        },
        { additionalProperties: false },
      ),
      recover: (_args, ctx) =>
        Effect.gen(function* () {
          const found = yield* daemon.store.tasks.taskByKey(ctx.key);
          if (!found) return false;
          const snapshot = yield* Effect.orElseSucceed(tasks.snapshot(ctx.bot, found.id), () => undefined);
          return snapshot ? json({ started: taskJson(snapshot), note: "Recovered after a daemon restart." }, { task: found.id }) : false;
        }),
      run: (args, ctx) =>
        Effect.gen(function* () {
          if (ctx.signal?.aborted) return refused("Not started: stopped by the user.");
          const started = yield* Effect.result(
            tasks.start({
              bot: ctx.bot,
              key: ctx.key,
              harness: args.harness,
              prompt: args.prompt,
              title: args.title,
              cwd: args.cwd,
              session: args.session,
              fork: args.fork,
              model: args.model,
              options: args.options,
              images: args.images,
            }),
          );
          if (started._tag === "Failure") return refused(started.failure);
          const { snapshot } = started.success;
          return json(
            {
              started: taskJson(snapshot),
              capabilities: snapshot.capabilities ? capabilityList(snapshot.capabilities) : undefined,
              next: "It runs in the background. You'll get a message when it ends or asks you something: carry on, or end your turn.",
            },
            { task: snapshot.task.id },
          );
        }),
    }),
    defineTool({
      name: "task_read",
      label: "Read a task",
      description: [
        "See a task's state, result and what it has done (its events), or, without `id`, your recent tasks and sessions.",
        "Events come in order after `after` (a cursor from an earlier read), at most `limit` at a time; read again from `cursor` while `more` is true.",
      ].join(" "),
      parameters: Type.Object(
        {
          id: Type.Optional(ids.id),
          after: Type.Optional(Type.Integer({ minimum: 0, description: "Only events after this cursor. Default 0: from the start." })),
          limit: Type.Optional(
            Type.Integer({ minimum: 1, maximum: MAX_READ, description: `How many events at most (default ${DEFAULT_READ}, up to ${MAX_READ}).` }),
          ),
          result_from: Type.Optional(
            Type.Integer({
              minimum: 0,
              description: "Read the result from this character on (a long result says where its next part starts: `result_more_from`).",
            }),
          ),
        },
        { additionalProperties: false },
      ),
      replay: "safe",
      background: false,
      run: (args, ctx) => {
        if (args.id === undefined)
          return Effect.gen(function* () {
            const rows = yield* daemon.store.tasks.tasksOf(ctx.bot, 20);
            const sessions = yield* tasks.sessions(ctx.bot);
            return json({
              tasks: rows.map((t) => ({ id: t.id, title: t.title, state: t.state, session: t.session, created_at: iso(t.createdAt) })),
              sessions: sessions.map((s) => ({
                id: s.id,
                harness: s.harness,
                cwd: s.cwd,
                ...(s.model ? { model: s.model } : {}),
                used_at: iso(s.usedAt),
              })),
            });
          });
        return run(tasks.read(ctx.bot, args.id, args.after ?? 0, args.limit ?? DEFAULT_READ), (read: ReadResult) =>
          json({
            task: taskJson(read, RESULT_IN_READ, args.result_from ?? 0),
            events: read.events.map((e) => ({ cursor: e.seq, at: iso(e.at), kind: e.kind, text: e.text })),
            cursor: read.cursor,
            more: read.more,
            ...(read.pruned ? { note: "Older events were dropped; only the newest are kept." } : {}),
          }),
        );
      },
    }),
    defineTool({
      name: "task_send",
      label: "Message a task",
      description: [
        "Send a running task more to do.",
        '`mode: "steer"` adds it to the turn that is running now, to correct course; it fails if no turn is running.',
        '`mode: "queue"` runs it as the next turn, after the current one finishes; the task only ends once its queued messages are done.',
        "A task that has ended takes no messages: continue its session with collar__task_start instead.",
      ].join(" "),
      parameters: Type.Object(
        {
          ...ids,
          text: Type.String({ description: "The message." }),
          mode: Type.Enum(["steer", "queue"], { description: "steer: into the running turn. queue: after it." }),
        },
        { additionalProperties: false },
      ),
      recover: (_args, ctx) =>
        Effect.map(daemon.store.tasks.messageByKey(ctx.key), (message) =>
          message ? json({ message: message.id, mode: message.mode, state: message.state, note: "Recovered after a daemon restart." }) : false,
        ),
      run: (args, ctx) =>
        run(tasks.send(ctx.bot, args.id, ctx.key, args.mode as "steer" | "queue", args.text), ({ message }) =>
          json({
            message: message.id,
            mode: message.mode,
            state: message.state,
            note: message.mode === "steer" ? "Delivered into the running turn." : "Queued: it runs when the current turn finishes.",
          }),
        ),
    }),
    defineTool({
      name: "task_respond",
      label: "Answer a task",
      description: [
        "Answer a request a task is waiting on (its `waiting_for` list in collar__task_read or collar__task_wait).",
        "Give `answers`, keyed by question id, each one of its options or your own words.",
        "Each request takes one answer: whoever answers first, you or the user, wins.",
      ].join(" "),
      parameters: Type.Object(
        {
          ...ids,
          request: Type.Integer({ description: "The request's number." }),
          answers: Type.Record(Type.String(), Type.Union([Type.String(), Type.Array(Type.String())]), {
            description: "Question id → answer (a list for multiple choice).",
          }),
        },
        { additionalProperties: false },
      ),
      recover: (args, ctx) =>
        Effect.map(daemon.store.tasks.input(args.request), (input) =>
          input && input.bot === ctx.bot && input.state === "answered" && input.answeredBy === "bot"
            ? json({ request: input.id, answered: true, note: "Recovered after a daemon restart." })
            : false,
        ),
      run: (args, ctx) => {
        const answers = Object.fromEntries(Object.entries(args.answers).map(([id, value]) => [id, Array.isArray(value) ? value : [value]]));
        return run(tasks.respond("bot", ctx.bot, args.id, args.request, { answers }), (input) => json({ request: input.id, answered: true }));
      },
    }),
    defineTool({
      name: "task_wait",
      label: "Wait for a task",
      description: [
        "Wait for a task to end or to need input, then get its state and result.",
        "You rarely need this: a task's end comes to you as a message by itself. Use it when you can't go on without the result.",
        `Waits at most \`timeout_seconds\` (default ${DEFAULT_WAIT_S}, up to ${MAX_WAIT_S}); if it's still going then, the result says "timedOut":true.`,
        '`until: "end"` keeps waiting through requests for input.',
      ].join(" "),
      parameters: Type.Object(
        {
          ...ids,
          timeout_seconds: Type.Optional(Type.Number({ minimum: 0, maximum: MAX_WAIT_S })),
          until: Type.Optional(Type.Enum(["input_or_end", "end"], { description: 'Default "input_or_end".' })),
        },
        { additionalProperties: false },
      ),
      replay: "safe",
      run: (args, ctx) =>
        run(
          tasks.wait(
            ctx.bot,
            args.id,
            Math.min(Math.max(0, args.timeout_seconds ?? DEFAULT_WAIT_S), MAX_WAIT_S) * 1000,
            args.until === "end" ? "end" : "input_or_end",
            ctx.signal,
          ),
          ({ snapshot, timedOut }) => json({ timedOut, task: taskJson(snapshot, RESULT_IN_READ) }),
        ),
    }),
    defineTool({
      name: "task_cancel",
      label: "Cancel a task",
      description:
        "Stop a task: its running turn is interrupted, requests it was waiting on are withdrawn and queued messages are dropped. Its session is kept, so you can continue it later. A task that already ended stays as it ended.",
      parameters: Type.Object(ids, { additionalProperties: false }),
      replay: "safe",
      background: false,
      run: (args, ctx) =>
        run(tasks.cancel(ctx.bot, args.id), ({ task, cancelled }) =>
          json({
            id: task.id,
            state: task.state,
            cancelled,
            ...(cancelled
              ? {}
              : {
                  note: taskEnded(task.state)
                    ? `It had already ${task.state === "completed" ? "completed" : `ended (${task.state})`}.`
                    : "It's still stopping; you'll get a message when it ends.",
                }),
          }),
        ),
    }),
  ];
};
