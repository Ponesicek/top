import { MAX_TASK_ANSWER, type TaskInputView, type TaskQuestion } from "@top/client";
import { SquareTerminal } from "lucide-react";
import { memo, useId, useState } from "react";
import { cn } from "../../lib/utils.ts";
import type { Row } from "../../rows.ts";
import { top, useClient } from "../../top.ts";
import { messageOf } from "../BotDialogs.tsx";
import { Button } from "../ui/button.tsx";
import { Input } from "../ui/field.tsx";

type AgentRow = Extract<Row, { kind: "agent" }>;
type QuestionRow = Extract<Row, { kind: "taskQuestion" }>;

const CARD = "flex w-fit max-w-[min(100%,34rem)] min-w-[min(100%,18rem)] flex-col gap-1.5 rounded-xl bg-muted px-3.5 py-3 inset-ring inset-ring-border";

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

function Questions({ task, input, online }: { task: string; input: TaskInputView; online: boolean }) {
  const questions: readonly TaskQuestion[] = input.questions;
  const [chosen, setChosen] = useState<Record<string, string[]>>({});
  const [typed, setTyped] = useState<Record<string, string>>({});
  const { busy, error, run } = useSend();
  const answerOf = (q: TaskQuestion) => {
    const text = typed[q.id]?.trim();
    const picked = chosen[q.id] ?? [];
    return text ? (q.multiple ? [...picked, text] : [text]) : picked;
  };
  const ready = questions.every((q) => answerOf(q).length > 0);
  const submit = () => run(() => top.answerTask(task, input.id, Object.fromEntries(questions.map((q) => [q.id, answerOf(q)]))));
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
            type="text"
            autoComplete="off"
            maxLength={MAX_TASK_ANSWER}
            placeholder={q.options.length ? "Or type an answer" : "Your answer"}
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
          Answer
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

/** Where a bot handed work to an agent, under the name the agent's harness got too: fixed when it started, it never changes after. */
export const AgentReceipt = memo(function AgentReceipt({ row, className }: { row: AgentRow; className?: string }) {
  const { title, harness, cwd, model } = row.agent;
  return (
    <div className={cn("py-1.5", className)}>
      <div className={CARD}>
        <div className="flex min-w-0 items-center gap-2">
          <SquareTerminal size={14} className="flex-none text-muted-foreground" aria-hidden />
          <span className="flex-none text-meta text-muted-foreground">{harness}</span>
          <span className="min-w-0 flex-1 truncate text-small font-medium text-foreground" title={title}>
            {title ?? "An agent was spawned"}
          </span>
        </div>
        <span className="truncate text-meta text-muted-foreground" title={`${cwd} · full access${model ? ` · ${model}` : ""}`}>
          {homeShort(cwd)} · Full access
          {model ? ` · ${model}` : ""}
        </span>
      </div>
    </div>
  );
});

/** An agent's questions for the user, at the end of the conversation until someone answers them. */
export const TaskQuestionCard = memo(function TaskQuestionCard({ row, className }: { row: QuestionRow; className?: string }) {
  const { task } = row;
  const online = useClient((s) => s.connection === "open");
  const titleId = useId();
  return (
    <div className={cn("py-1.5", className)}>
      <section aria-labelledby={titleId} className={CARD}>
        <div className="flex min-w-0 items-center gap-2">
          <SquareTerminal size={14} className="flex-none text-muted-foreground" aria-hidden />
          <span className="flex-none text-meta text-muted-foreground">An agent asks</span>
          <span id={titleId} className="min-w-0 flex-1 truncate text-small font-medium text-foreground" title={task.title}>
            {task.title}
          </span>
        </div>
        <div className="mt-1 flex flex-col gap-3 border-t border-border pt-2.5">
          {task.inputs.map((input) => (
            <Questions key={input.id} task={task.id} input={input} online={online} />
          ))}
        </div>
      </section>
    </div>
  );
});
