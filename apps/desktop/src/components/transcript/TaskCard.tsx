import { MAX_TASK_ANSWER, type TaskDecision, type TaskInputView, type TaskQuestion, type TaskState, type TaskView, taskEnded } from "@top/client";
import { Check, CircleSlash, LoaderCircle, SquareTerminal, X } from "lucide-react";
import { memo, useId, useState } from "react";
import { cn } from "../../lib/utils.ts";
import type { Row } from "../../rows.ts";
import { top, useClient } from "../../top.ts";
import { messageOf } from "../BotDialogs.tsx";
import { Badge } from "../ui/badge.tsx";
import { Button } from "../ui/button.tsx";
import { Input } from "../ui/field.tsx";

type TaskRow = Extract<Row, { kind: "task" }>;

const STATE: Record<TaskState, { label: string; variant: "primary" | "success" | "warning" | "tool" | "destructive" }> = {
  queued: { label: "Queued", variant: "tool" },
  starting: { label: "Starting", variant: "tool" },
  running: { label: "Running", variant: "primary" },
  waiting_for_input: { label: "Needs an answer", variant: "warning" },
  completed: { label: "Done", variant: "success" },
  failed: { label: "Failed", variant: "destructive" },
  cancelled: { label: "Cancelled", variant: "tool" },
};

const POLICY: Record<TaskView["policy"], string> = {
  read_only: "Read only",
  workspace_write: "Edits this folder",
  full_access: "Full access",
};

const DECISION: Record<TaskDecision, string> = { allow: "Allow", allow_for_session: "Allow for this session", deny: "Deny" };

function homeShort(path: string): string {
  return path.replace(/^\/home\/[^/]+(?=\/|$)/, "~").replace(/^\/Users\/[^/]+(?=\/|$)/, "~");
}

function useSend() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

function Decisions({ task, input, online }: { task: TaskView; input: TaskInputView; online: boolean }) {
  const { busy, error, run } = useSend();
  const titleId = useId();
  const decisions = input.decisions ?? ["allow", "deny"];
  return (
    <div className="flex flex-col gap-1">
      <span id={titleId} className="text-small leading-snug font-medium break-words whitespace-pre-wrap text-foreground">
        {input.title}
      </span>
      {input.detail && <span className="text-meta break-words whitespace-pre-wrap text-secondary-foreground">{input.detail}</span>}
      <div className="mt-1 flex flex-wrap items-center gap-2 text-meta">
        {decisions.map((decision) => (
          <Button
            key={decision}
            size="xs"
            variant={decision === "allow" ? "default" : "outline"}
            className="h-7.5 px-3 text-meta"
            disabled={busy || !online}
            aria-describedby={titleId}
            onClick={() => run(() => top.answerTask(task.id, input.id, { decision }))}
          >
            {DECISION[decision]}
          </Button>
        ))}
        {!online && <span className="text-muted-foreground">Reconnecting…</span>}
      </div>
      {error && (
        <span role="alert" className="text-meta text-destructive-foreground">
          {error}
        </span>
      )}
    </div>
  );
}

function Questions({ task, input, online }: { task: TaskView; input: TaskInputView; online: boolean }) {
  const questions: readonly TaskQuestion[] = input.questions ?? [];
  const [chosen, setChosen] = useState<Record<string, string[]>>({});
  const [typed, setTyped] = useState<Record<string, string>>({});
  const { busy, error, run } = useSend();
  const answerOf = (q: TaskQuestion) => {
    const text = typed[q.id]?.trim();
    const picked = chosen[q.id] ?? [];
    return text ? (q.multiple ? [...picked, text] : [text]) : picked;
  };
  const ready = questions.every((q) => answerOf(q).length > 0);
  const submit = () => run(() => top.answerTask(task.id, input.id, { answers: Object.fromEntries(questions.map((q) => [q.id, answerOf(q)])) }));
  const pick = (q: TaskQuestion, label: string) =>
    setChosen((prev) => {
      const now = prev[q.id] ?? [];
      const next = q.multiple ? (now.includes(label) ? now.filter((l) => l !== label) : [...now, label]) : [label];
      return { ...prev, [q.id]: next };
    });

  return (
    <form
      className="flex flex-col gap-2.5"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) submit();
      }}
    >
      {questions.map((q) => (
        <fieldset key={q.id} className="flex min-w-0 flex-col gap-1.5">
          <legend className="text-small leading-snug font-medium break-words whitespace-pre-wrap text-foreground">
            {q.header && <span className="mr-1.5 text-meta text-muted-foreground">{q.header}</span>}
            {q.question}
          </legend>
          {q.options.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {q.options.map((option) => {
                const on = (chosen[q.id] ?? []).includes(option.label);
                return (
                  <Button
                    key={option.label}
                    type="button"
                    size="xs"
                    variant={on ? "default" : "outline"}
                    aria-pressed={on}
                    title={option.description}
                    className="h-7.5 max-w-full px-3 text-meta"
                    disabled={busy || !online}
                    onClick={() => pick(q, option.label)}
                  >
                    <span className="truncate">{option.label}</span>
                  </Button>
                );
              })}
            </div>
          )}
          <Input
            type={q.secret ? "password" : "text"}
            autoComplete="off"
            maxLength={MAX_TASK_ANSWER}
            placeholder={q.secret ? "Secret: sent only to the harness, never kept" : q.options.length ? "Or type an answer" : "Your answer"}
            aria-label={q.question}
            className="h-8 py-1 text-small"
            value={typed[q.id] ?? ""}
            disabled={busy || !online}
            onChange={(event) => setTyped((prev) => ({ ...prev, [q.id]: event.target.value }))}
          />
        </fieldset>
      ))}
      <div className="flex flex-wrap items-center gap-2 text-meta">
        <Button type="submit" size="xs" className="h-7.5 px-3 text-meta" disabled={!ready || busy || !online}>
          {questions.some((q) => q.secret) ? "Send" : "Answer"}
        </Button>
        {!online && <span className="text-muted-foreground">Reconnecting…</span>}
      </div>
      {error && (
        <span role="alert" className="text-meta text-destructive-foreground">
          {error}
        </span>
      )}
    </form>
  );
}

export const TaskCard = memo(function TaskCard({ row, className }: { row: TaskRow; className?: string }) {
  const task = useClient((s) => s.tasks.find((t) => t.id === row.task));
  const online = useClient((s) => s.connection === "open");
  const cancel = useSend();
  const titleId = useId();

  if (!task) {
    return (
      <div className={cn("py-1.5", className)}>
        <div className="flex w-fit max-w-[min(100%,34rem)] items-center gap-2 rounded-xl bg-muted px-3.5 py-2.5 text-meta text-muted-foreground inset-ring inset-ring-border">
          <SquareTerminal size={14} aria-hidden />
          <span className="truncate">{row.title ?? "Coding task"}</span>
        </div>
      </div>
    );
  }

  const state = STATE[task.state];
  const ended = taskEnded(task.state);
  const busy = task.state === "starting" || task.state === "running";
  return (
    <div className={cn("py-1.5", className)}>
      <section
        aria-labelledby={titleId}
        className="flex w-fit max-w-[min(100%,34rem)] min-w-[min(100%,18rem)] flex-col gap-1.5 rounded-xl bg-muted px-3.5 py-3 inset-ring inset-ring-border"
      >
        <div className="flex min-w-0 items-center gap-2">
          <SquareTerminal size={14} className="flex-none text-muted-foreground" aria-hidden />
          <span className="flex-none text-meta text-muted-foreground">{task.harness}</span>
          <span id={titleId} className="min-w-0 flex-1 truncate text-small font-medium text-foreground" title={task.title}>
            {task.title}
          </span>
          <Badge variant={state.variant} size="md" className="flex-none">
            {busy && <LoaderCircle size={11} className="animate-spin motion-reduce:animate-none" aria-hidden />}
            {task.state === "completed" && <Check size={11} strokeWidth={2.6} aria-hidden />}
            {task.state === "failed" && <X size={11} strokeWidth={2.6} aria-hidden />}
            {task.state === "cancelled" && <CircleSlash size={11} aria-hidden />}
            {state.label}
          </Badge>
        </div>
        <span className="truncate text-meta text-muted-foreground" title={`${task.cwd} · ${POLICY[task.policy]}${task.model ? ` · ${task.model}` : ""}`}>
          {homeShort(task.cwd)} · {POLICY[task.policy]}
          {task.model ? ` · ${task.model}` : ""}
        </span>
        {task.error ? (
          <span className="text-meta break-words text-destructive-foreground">{task.error}</span>
        ) : (
          task.latest && task.inputs.length === 0 && <span className="truncate font-mono text-[12px] text-secondary-foreground">{task.latest}</span>
        )}
        {task.inputs.length > 0 && (
          <div className="mt-1 flex flex-col gap-3 border-t border-border pt-2.5">
            {task.inputs.map((input) =>
              input.kind === "question" ? (
                <Questions key={input.id} task={task} input={input} online={online} />
              ) : (
                <Decisions key={input.id} task={task} input={input} online={online} />
              ),
            )}
          </div>
        )}
        {!ended && (
          <div className="mt-0.5 flex items-center gap-2 text-meta">
            <Button
              size="xs"
              variant="ghost"
              className="-ml-2 h-7 px-2 text-meta text-muted-foreground"
              disabled={cancel.busy || !online}
              onClick={() => cancel.run(() => top.cancelTask(task.id))}
            >
              Cancel task
            </Button>
            {cancel.error && (
              <span role="alert" className="text-destructive-foreground">
                {cancel.error}
              </span>
            )}
          </div>
        )}
      </section>
    </div>
  );
});
