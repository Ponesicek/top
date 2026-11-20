import type { AskOutcome, PermissionAsk, QuestionAsk, QuestionReply, SecretAsk } from "@top/client";
import { Check, CircleSlash, ExternalLink, KeyRound, LockKeyhole, X } from "lucide-react";
import { memo, type ReactNode, type RefObject, useEffect, useId, useRef, useState } from "react";
import { cn } from "../../lib/utils.ts";
import type { Row } from "../../rows.ts";
import { top, useClient } from "../../top.ts";
import { messageOf } from "../BotDialogs.tsx";
import { Button } from "../ui/button.tsx";
import { Input } from "../ui/field.tsx";
import { useIdentity } from "./parts.tsx";

type AskRow = Extract<Row, { kind: "ask" }>;
type Settled = { readonly icon: typeof Check; readonly text: string; readonly tone: string };

const WITHDRAWN: Settled = { icon: CircleSlash, text: "Not answered: the request was withdrawn", tone: "text-muted-foreground" };
const SETTLED: Record<AskOutcome, Settled> = {
  allowed: { icon: Check, text: "Allowed", tone: "text-success-foreground" },
  denied: { icon: X, text: "Denied", tone: "text-destructive-foreground" },
  answered: { icon: Check, text: "Answered", tone: "text-success-foreground" },
  saved: { icon: LockKeyhole, text: "Saved", tone: "text-success-foreground" },
  declined: { icon: X, text: "Declined", tone: "text-muted-foreground" },
  withdrawn: WITHDRAWN,
};

const ACTION = "h-7.5 px-3 text-meta";

function useAnswering(row: AskRow, card: RefObject<HTMLElement | null>) {
  const id = row.ask.id;
  const waiting = useClient((s) => s.asks.some((a) => a.ask.id === id && a.bot === row.bot));
  const online = useClient((s) => s.connection === "open");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const send = async (answer: () => Promise<void>) => {
    if (!waiting || busy) return false;
    if (card.current?.contains(document.activeElement)) card.current.focus();
    setBusy(true);
    setError(undefined);
    try {
      await answer();
      return true;
    } catch (err) {
      setError(messageOf(err));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { target: { id, bot: row.bot }, off: !waiting || busy, online, error, send };
}

function Frame({
  row,
  card,
  titleId,
  meta,
  title,
  children,
  error,
  online,
  settledText,
  className,
}: {
  row: AskRow;
  card: RefObject<HTMLElement | null>;
  titleId: string;
  meta: string;
  title: ReactNode;
  children: ReactNode;
  error: string | undefined;
  online: boolean;
  settledText?: string | undefined;
  className?: string | undefined;
}) {
  const settled = row.answer ? SETTLED[row.answer] : undefined;
  return (
    <div className={cn("py-1.5", className)}>
      <section
        ref={card}
        tabIndex={-1}
        aria-labelledby={titleId}
        className="flex w-fit max-w-[min(100%,32rem)] min-w-0 flex-col gap-1 rounded-xl bg-muted px-3.5 py-3 inset-ring inset-ring-border outline-hidden focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-primary"
      >
        <span className="text-meta text-muted-foreground">{meta}</span>
        <span id={titleId} className="text-small leading-snug font-medium break-words whitespace-pre-wrap text-foreground">
          {title}
        </span>
        {children}
        {!settled && !online && <span className="text-meta text-muted-foreground">Reconnecting…</span>}
        <div role="status" className={settled ? "text-meta" : "-mt-1"}>
          {settled && (
            <span className={cn("mt-1 inline-flex items-center gap-1.5 font-label", settled.tone)}>
              <settled.icon size={13} strokeWidth={2.4} aria-hidden />
              {settledText ?? settled.text}
            </span>
          )}
        </div>
        {error && !settled && (
          <span role="alert" className="text-meta break-words text-destructive-foreground">
            {error}
          </span>
        )}
      </section>
    </div>
  );
}

function PermissionCard({ row, ask, className }: { row: AskRow; ask: PermissionAsk; className?: string | undefined }) {
  const { name } = useIdentity();
  const card = useRef<HTMLElement>(null);
  const titleId = useId();
  const { target, off, online, error, send } = useAnswering(row, card);
  const decide = (allow: boolean) => send(() => top.answerPermission(target, allow));
  return (
    <Frame
      row={row}
      card={card}
      titleId={titleId}
      meta={row.answer ? `${name} asked for your approval` : "Needs your approval"}
      title={ask.action}
      error={error}
      online={online}
      className={className}
    >
      {ask.reason && <span className="text-meta break-words whitespace-pre-wrap text-secondary-foreground">{ask.reason}</span>}
      {!row.answer && (
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <Button size="xs" className={ACTION} disabled={off} onClick={() => decide(true)} aria-describedby={titleId}>
            Allow
          </Button>
          <Button size="xs" variant="outline" className={ACTION} disabled={off} onClick={() => decide(false)} aria-describedby={titleId}>
            Deny
          </Button>
        </div>
      )}
    </Frame>
  );
}

function replyText(ask: QuestionAsk, reply: QuestionReply | undefined): string | undefined {
  if (!reply) return undefined;
  const parts = [...reply.choices.map((i) => ask.options[i]?.label ?? "?"), ...(reply.text ? [`“${reply.text}”`] : [])];
  return `You answered: ${parts.join(", ")}`;
}

function QuestionCard({ row, ask, className }: { row: AskRow; ask: QuestionAsk; className?: string | undefined }) {
  const { name } = useIdentity();
  const card = useRef<HTMLElement>(null);
  const titleId = useId();
  const { target, off, online, error, send } = useAnswering(row, card);
  const [choices, setChoices] = useState<readonly number[]>([]);
  const [text, setText] = useState("");
  const writes = !ask.options.length || !!ask.other;
  const ready = choices.length > 0 || text.trim().length > 0;
  const pick = (i: number) => setChoices((now) => (now.includes(i) ? now.filter((c) => c !== i) : ask.multiple ? [...now, i] : [i]));
  const submit = () => {
    if (!ready) return;
    void send(() => top.answerQuestion(target, { choices: [...choices].sort((a, b) => a - b), ...(text.trim() ? { text: text.trim() } : {}) }));
  };
  const settledText = row.answer === "answered" ? replyText(ask, row.reply) : row.answer === "declined" ? "Skipped" : undefined;
  return (
    <Frame
      row={row}
      card={card}
      titleId={titleId}
      meta={row.answer ? `${name} asked` : "Question"}
      title={ask.question}
      error={error}
      online={online}
      settledText={settledText}
      className={className}
    >
      {ask.detail && <span className="text-meta break-words whitespace-pre-wrap text-secondary-foreground">{ask.detail}</span>}
      {!row.answer && (
        <>
          {ask.options.length > 0 && (
            <fieldset className="mt-1.5 flex min-w-0 flex-col gap-1.5" aria-labelledby={titleId} disabled={off}>
              {ask.options.map((option, i) => {
                const on = choices.includes(i);
                return (
                  <label
                    key={option.label}
                    className={cn(
                      "flex cursor-pointer items-start gap-2.5 rounded-lg bg-background px-3 py-2 inset-ring transition-shadow duration-90 has-focus-visible:shadow-focus has-disabled:cursor-default has-disabled:opacity-60",
                      on ? "inset-ring-primary" : "inset-ring-input hover:inset-ring-muted-foreground/50",
                    )}
                  >
                    <input
                      type={ask.multiple ? "checkbox" : "radio"}
                      name={titleId}
                      className="sr-only"
                      checked={on}
                      onChange={() => pick(i)}
                      onClick={() => !ask.multiple && on && pick(i)}
                    />
                    <span
                      className={cn(
                        "mt-0.75 grid size-3.75 flex-none place-items-center border",
                        ask.multiple ? "rounded-[4px]" : "rounded-full",
                        on ? "border-primary bg-primary text-primary-foreground" : "border-input",
                      )}
                      aria-hidden
                    >
                      {on && <Check size={10} strokeWidth={3} />}
                    </span>
                    <span className="flex min-w-0 flex-col">
                      <span className="text-small leading-snug font-label break-words text-foreground">{option.label}</span>
                      {option.description && <span className="text-meta break-words text-muted-foreground">{option.description}</span>}
                    </span>
                  </label>
                );
              })}
            </fieldset>
          )}
          {writes && (
            <Input
              className="mt-1.5 py-1.75 text-small"
              value={text}
              disabled={off}
              placeholder={ask.options.length ? "Something else…" : "Your answer"}
              aria-label={ask.options.length ? "Your own answer" : "Your answer"}
              onValueChange={setText}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing) submit();
              }}
            />
          )}
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <Button size="xs" className={ACTION} disabled={off || !ready} onClick={submit} aria-describedby={titleId}>
              Send
            </Button>
            <Button size="xs" variant="outline" className={ACTION} disabled={off} onClick={() => send(() => top.decline(target))} aria-describedby={titleId}>
              Skip
            </Button>
          </div>
        </>
      )}
    </Frame>
  );
}

function hostOf(url: string): string | undefined {
  if (!/^https?:\/\//i.test(url)) return undefined;
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

function SecretCard({ row, ask, className }: { row: AskRow; ask: SecretAsk; className?: string | undefined }) {
  const { name } = useIdentity();
  const card = useRef<HTMLElement>(null);
  const titleId = useId();
  const noteId = useId();
  const { target, off, online, error, send } = useAnswering(row, card);
  const [value, setValue] = useState("");
  const settled = !!row.answer;
  useEffect(() => {
    if (settled) setValue("");
  }, [settled]);
  const host = ask.url ? hostOf(ask.url) : undefined;
  const save = async () => {
    if (!value.trim()) return;
    if (await send(() => top.saveSecret(target, value))) setValue("");
  };
  const settledText = row.answer === "saved" ? `Saved for ${name}'s commands` : undefined;
  return (
    <Frame
      row={row}
      card={card}
      titleId={titleId}
      meta={row.answer ? `${name} asked for a secret` : "Needs a secret"}
      title={
        <span className="inline-flex items-start gap-1.5">
          <KeyRound size={14} strokeWidth={2.2} className="mt-0.75 flex-none text-muted-foreground" aria-hidden />
          {ask.label}
        </span>
      }
      error={error}
      online={online}
      settledText={settledText}
      className={className}
    >
      <span className="text-meta break-words whitespace-pre-wrap text-secondary-foreground">{ask.reason}</span>
      {!row.answer && (
        <>
          {ask.url && host && (
            <button
              type="button"
              className="inline-flex items-center gap-1 self-start text-meta text-link underline-offset-2 hover:underline"
              title={ask.url}
              onClick={() => window.open(ask.url, "_blank", "noopener")}
            >
              Get it at {host}
              <ExternalLink size={12} strokeWidth={2} aria-hidden />
            </button>
          )}
          <Input
            className="mt-1.5 py-1.75 font-mono text-small"
            type="password"
            autoComplete="off"
            spellCheck={false}
            data-1p-ignore
            data-lpignore="true"
            value={value}
            disabled={off}
            placeholder={ask.placeholder ?? "Paste it here"}
            aria-label={ask.label}
            aria-describedby={noteId}
            onValueChange={setValue}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) void save();
            }}
          />
          <span id={noteId} className="text-meta text-muted-foreground">
            It goes to a file for {name}'s commands, deleted after an hour, and never shows in the conversation.
          </span>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <Button size="xs" className={ACTION} disabled={off || !value.trim()} onClick={save} aria-describedby={titleId}>
              Save
            </Button>
            <Button size="xs" variant="outline" className={ACTION} disabled={off} onClick={() => send(() => top.decline(target))} aria-describedby={titleId}>
              Decline
            </Button>
          </div>
        </>
      )}
    </Frame>
  );
}

export const AskCard = memo(function AskCard({ row, className }: { row: AskRow; className?: string }) {
  const ask = row.ask;
  if (ask.kind === "permission") return <PermissionCard row={row} ask={ask} className={className} />;
  if (ask.kind === "question") return <QuestionCard row={row} ask={ask} className={className} />;
  return <SecretCard row={row} ask={ask} className={className} />;
});
