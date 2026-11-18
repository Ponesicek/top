import {
  AskError,
  type AskOutcome,
  type AskReply,
  MAX_ANSWER_TEXT,
  MAX_SECRET_BYTES,
  type QuestionAsk,
  type QuestionReply,
  type SecretAsk,
  type WaitingAsk,
} from "@top/protocol";
import * as Effect from "effect/Effect";
import type { Secrets } from "./secrets.ts";
import type { AskBody, AskRow, InboxRow, Store, StoredEntry } from "./store.ts";

export type Asks = {
  readonly waiting: Effect.Effect<WaitingAsk[]>;
  readonly ask: (bot: number, key: string, body: AskBody) => Effect.Effect<AskRow>;
  readonly askedBy: (key: string) => Effect.Effect<AskRow | undefined>;
  readonly answer: (id: number, bot: number, reply: AskReply) => Effect.Effect<void, AskError>;
  readonly saveSecret: (id: number, bot: number, value: string) => Effect.Effect<void, AskError>;
  readonly withdraw: (bot: number) => Effect.Effect<void>;
};

export type AsksEvents = {
  readonly entry: (entry: StoredEntry) => Effect.Effect<void>;
  readonly deliver: (row: InboxRow) => Effect.Effect<void>;
  readonly changed: (bot: number) => Effect.Effect<void>;
};

const NOT_WAITING = "That request was already answered, or isn't waiting anymore.";
const refuse = (message: string) => new AskError({ message });

const shellQuoted = (path: string) => `'${path.replace(/'/g, `'\\''`)}'`;

const permissionText = (allow: boolean, action: string) =>
  allow ? `[Permission] The user allowed: ${action}.` : `[Permission] The user denied: ${action}. Don't do it.`;

export function answerText(ask: QuestionAsk, reply: QuestionReply | undefined): string {
  const asked = `[Answer] You asked: ${ask.question}`;
  if (!reply) return `${asked}\nThe user dismissed it without answering. Carry on without it, or say what's blocked.`;
  const chose = reply.choices.map((i) => ask.options[i]!.label);
  return [asked, ...(chose.length ? [`The user chose: ${chose.join("; ")}`] : []), ...(reply.text ? [`The user wrote: ${reply.text}`] : [])].join("\n");
}

export function secretText(ask: SecretAsk, saved: { readonly path: string; readonly minutes: number } | undefined): string {
  if (!saved) return `[Secret] The user declined to give ${ask.label}. Don't ask for it in chat or another way; say what's blocked and carry on without it.`;
  return [
    `[Secret] The user saved ${ask.label} for your commands, in the file ${saved.path}. You never see the value, and Top hides it if a command prints it.`,
    `Read it only inside the command that uses it, like "$(cat ${shellQuoted(saved.path)})" or a tool's option to read it from a file. Never print, copy or store it anywhere: not in a message, a file, memory, git or a command's output.`,
    `The file is deleted in ${saved.minutes} minute${saved.minutes === 1 ? "" : "s"}; if you need it after that, ask again with request_secret.`,
  ].join("\n");
}

function checkReply(ask: QuestionAsk, reply: Extract<AskReply, { kind: "question" }>): Effect.Effect<QuestionReply, AskError> {
  const choices = [...new Set(reply.choices)];
  if (choices.some((i) => !Number.isInteger(i) || i < 0 || i >= ask.options.length)) return Effect.fail(refuse("That option isn't one of the question's."));
  if (choices.length > 1 && !ask.multiple) return Effect.fail(refuse("Pick one option."));
  const text = reply.text?.trim() ?? "";
  if (text && ask.options.length && !ask.other) return Effect.fail(refuse("This question takes one of its options."));
  if (text.length > MAX_ANSWER_TEXT) return Effect.fail(refuse(`Keep the answer under ${MAX_ANSWER_TEXT + 1} characters.`));
  if (!choices.length && !text) return Effect.fail(refuse(ask.options.length ? "Pick an option first." : "Write an answer first."));
  return Effect.succeed({ choices: choices.sort((a, b) => a - b), ...(text ? { text } : {}) });
}

export function makeAsks(store: Store["Service"], secrets: Secrets["Service"], events: AsksEvents): Asks {
  const settle = (bot: number, id: number, outcome: AskOutcome, extra?: { reply?: QuestionReply | undefined; text?: string | undefined }) =>
    Effect.gen(function* () {
      const settled = yield* store.settle(bot, id, outcome, extra);
      if (!settled) return false;
      yield* events.entry(settled.entry);
      if (settled.message) yield* events.deliver(settled.message);
      yield* events.changed(bot);
      return true;
    });

  const waitingAsk = (id: number, bot: number) =>
    Effect.flatMap(store.waitingOf(bot), (rows) => {
      const row = rows.find((r) => r.id === id);
      return row ? Effect.succeed(row.ask) : Effect.fail(refuse(NOT_WAITING));
    });

  const settled = (done: boolean) => (done ? Effect.void : Effect.fail(refuse(NOT_WAITING)));

  return {
    waiting: Effect.map(store.waiting, (rows) => rows.map((row) => ({ bot: row.bot, ask: row.ask }))),
    ask: (bot, key, body) =>
      Effect.gen(function* () {
        const row = yield* store.ask(bot, key, body);
        if (row.state === "pending") yield* events.changed(bot);
        return row;
      }),
    askedBy: store.askedBy,
    answer: (id, bot, reply) =>
      Effect.gen(function* () {
        const ask = yield* waitingAsk(id, bot);
        if (reply.kind === "decline") {
          if (ask.kind === "permission") return yield* refuse("Answer a permission request with Allow or Deny.");
          const text = ask.kind === "question" ? answerText(ask, undefined) : secretText(ask, undefined);
          return yield* Effect.flatMap(settle(bot, id, "declined", { text }), settled);
        }
        if (reply.kind !== ask.kind) return yield* refuse("That answer doesn't fit the request.");
        if (reply.kind === "permission" && ask.kind === "permission")
          return yield* Effect.flatMap(settle(bot, id, reply.allow ? "allowed" : "denied", { text: permissionText(reply.allow, ask.action) }), settled);
        if (reply.kind === "question" && ask.kind === "question") {
          const checked = yield* checkReply(ask, reply);
          return yield* Effect.flatMap(settle(bot, id, "answered", { reply: checked, text: answerText(ask, checked) }), settled);
        }
      }),
    saveSecret: (id, bot, raw) =>
      Effect.gen(function* () {
        const ask = yield* waitingAsk(id, bot);
        if (ask.kind !== "secret") return yield* refuse("That request doesn't take a secret.");
        const value = raw.trim();
        if (!value) return yield* refuse("Enter the secret first.");
        if (Buffer.byteLength(value) > MAX_SECRET_BYTES) return yield* refuse(`That's longer than a secret can be (${MAX_SECRET_BYTES / 1024} KB).`);
        if (/[\r\n]/.test(value)) return yield* refuse("Secrets are one line. Paste it without line breaks.");
        const saved = yield* secrets.save(bot, value);
        const text = secretText(ask, { path: saved.path, minutes: Math.max(1, Math.round(secrets.ttlMs / 60_000)) });
        const done = yield* settle(bot, id, "saved", { text });
        if (!done) {
          yield* secrets.discard(saved.path);
          return yield* refuse(NOT_WAITING);
        }
      }),
    withdraw: (bot) =>
      Effect.gen(function* () {
        for (const row of yield* store.waitingOf(bot)) yield* settle(bot, row.id, "withdrawn");
      }),
  };
}
