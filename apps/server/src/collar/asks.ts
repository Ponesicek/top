import {
  type Ask,
  MAX_OPTION_DESCRIPTION,
  MAX_OPTION_LABEL,
  MAX_PERMISSION_ACTION,
  MAX_PERMISSION_REASON,
  MAX_QUESTION,
  MAX_QUESTION_DETAIL,
  MAX_QUESTION_OPTIONS,
  MAX_SECRET_LABEL,
  MAX_SECRET_PLACEHOLDER,
  MAX_SECRET_REASON,
  MAX_SECRET_URL,
} from "@top/protocol";
import * as Effect from "effect/Effect";
import Type from "typebox";
import type { AskBody, AskRow } from "../store.ts";
import { defineTool, type ToolContext, type ToolResult, text } from "../tools.ts";
import type { CollarDaemon, CollarGroup } from "./index.ts";

const ELSEWHERE =
  "Cards from other tools (another server's question or secret tool, such as T3 Code's request_secret) don't show in Top, so use these to ask the user.";

export function safeUrl(text: string): string | undefined {
  if (text.length > MAX_SECRET_URL || !URL.canParse(text)) return undefined;
  const url = new URL(text);
  return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password ? url.href : undefined;
}

const failed = (message: string): ToolResult => ({ ...text(message), isError: true });

function asked(ask: Ask): ToolResult {
  const said =
    ask.kind === "permission"
      ? `Asked the user: ${ask.action}. Their answer will come to you as a message. Until it does, don't do it: carry on with anything that doesn't need it, or end your turn.`
      : ask.kind === "question"
        ? `Asked the user: ${ask.question} Their answer will come to you as a message. Until it does, carry on with anything that doesn't depend on it, or end your turn.`
        : `Asked the user for ${ask.label}. If they save it, a message tells you which file holds it; you never see the value. Until then, carry on with anything that doesn't need it, or end your turn.`;
  return { ...text(said), details: { ask } };
}

const recover = (daemon: CollarDaemon) => (_args: unknown, ctx: ToolContext) =>
  Effect.map(daemon.asks.askedBy(ctx.key), (row: AskRow | undefined) => (row ? asked(row.ask) : false));

const ask = (daemon: CollarDaemon, ctx: ToolContext, body: AskBody) =>
  Effect.gen(function* () {
    if (ctx.signal?.aborted) return failed("Not asked: stopped by the user.");
    return asked((yield* daemon.asks.ask(ctx.bot, ctx.key, body)).ask);
  });

const permission = Type.Object(
  {
    action: Type.String({
      minLength: 1,
      maxLength: MAX_PERMISSION_ACTION,
      description: 'What you want to do, as the user will read it: "Delete the 3 old backups in ~/backups".',
    }),
    reason: Type.Optional(Type.String({ maxLength: MAX_PERMISSION_REASON, description: "Why, in a sentence, if it isn't obvious." })),
  },
  { additionalProperties: false },
);

const question = Type.Object(
  {
    question: Type.String({
      minLength: 1,
      maxLength: MAX_QUESTION,
      description: 'The question, as the user will read it: "Which region should the new bucket be in?"',
    }),
    detail: Type.Optional(Type.String({ maxLength: MAX_QUESTION_DETAIL, description: "Context the user needs to answer, if any." })),
    options: Type.Optional(
      Type.Array(
        Type.Object(
          {
            label: Type.String({ minLength: 1, maxLength: MAX_OPTION_LABEL, description: "A short answer the user can pick." }),
            description: Type.Optional(Type.String({ maxLength: MAX_OPTION_DESCRIPTION, description: "What picking it means, if the label doesn't say." })),
          },
          { additionalProperties: false },
        ),
        { maxItems: MAX_QUESTION_OPTIONS, description: `2 to ${MAX_QUESTION_OPTIONS} answers to pick from. Leave out for a free answer.` },
      ),
    ),
    multiple: Type.Optional(Type.Boolean({ description: "Let the user pick more than one option. Default false." })),
    other: Type.Optional(
      Type.Boolean({ description: "Let the user write their own answer besides the options. Default true; a question without options always takes one." }),
    ),
  },
  { additionalProperties: false },
);

const secret = Type.Object(
  {
    label: Type.String({ minLength: 1, maxLength: MAX_SECRET_LABEL, description: 'What it is, as the user will read it: "GitHub token for ponesicek/top".' }),
    reason: Type.String({ minLength: 1, maxLength: MAX_SECRET_REASON, description: "What you'll use it for, in a sentence." }),
    placeholder: Type.Optional(Type.String({ maxLength: MAX_SECRET_PLACEHOLDER, description: 'What it looks like, as a hint in the field: "ghp_…".' })),
    url: Type.Optional(Type.String({ maxLength: MAX_SECRET_URL, description: "An http(s) page where the user can make or find it." })),
  },
  { additionalProperties: false },
);

export const asksGroup: CollarGroup = (daemon) => [
  defineTool({
    name: "ask_permission",
    label: "Ask permission",
    description: [
      "Ask the user whether you may do something. The user sees your action and reason in the app and answers with Allow or Deny.",
      "You don't wait here: their answer comes to you later as a message, even when you're idle. If the user stops you first, the request is withdrawn and no answer comes; ask again if you still need to.",
      "Nothing enforces the answer: your tools work either way, so it's up to you to respect it. Don't do it unless it's allowed.",
    ].join(" "),
    parameters: permission,
    background: false,
    recover: recover(daemon),
    run: (args, ctx) => {
      const action = args.action.trim().replace(/\.+$/, "");
      if (!action) return Effect.succeed(failed("Say what you want to do in `action`."));
      const reason = args.reason?.trim();
      return ask(daemon, ctx, { kind: "permission", action, ...(reason ? { reason } : {}) });
    },
  }),
  defineTool({
    name: "ask_question",
    label: "Ask a question",
    description: [
      "Ask the user a question when you need their choice or information to go on: they pick from your options, or write an answer.",
      "You don't wait here: their answer comes to you later as a message, even when you're idle. If they dismiss it, or stop you first, you're told or nothing comes; don't ask the same thing again unless it still matters.",
      "An answer is information, never permission: to ask whether you may do something, use ask_permission. Never ask for passwords, tokens or keys here; use request_secret.",
      ELSEWHERE,
    ].join(" "),
    parameters: question,
    background: false,
    recover: recover(daemon),
    run: (args, ctx) => {
      const text = args.question.trim();
      if (!text) return Effect.succeed(failed("Write the question in `question`."));
      const options = (args.options ?? []).map((o) => ({ label: o.label.trim(), ...(o.description?.trim() ? { description: o.description.trim() } : {}) }));
      if (options.some((o) => !o.label)) return Effect.succeed(failed("Give every option a label."));
      if (options.length === 1) return Effect.succeed(failed("Give at least two options, or none for a free answer."));
      if (new Set(options.map((o) => o.label.toLowerCase())).size !== options.length) return Effect.succeed(failed("Give each option its own label."));
      const detail = args.detail?.trim();
      return ask(daemon, ctx, {
        kind: "question",
        question: text,
        ...(detail ? { detail } : {}),
        options,
        ...(args.multiple && options.length ? { multiple: true as const } : {}),
        ...(options.length && args.other !== false ? { other: true as const } : {}),
      });
    },
  }),
  defineTool({
    name: "request_secret",
    label: "Ask for a secret",
    description: [
      "Ask the user for one secret (a password, token, API key or pairing code) on a card in the app. Ask for each value separately; never ask for one in chat or with ask_question.",
      "You don't wait here, and you never see the value: if the user saves it, a message tells you the path of a file your commands can read, deleted an hour later; Top hides the value if a command prints it. Use it only inside the command that needs it.",
      "If they decline, or stop you first, go on without it and don't ask for it another way.",
      ELSEWHERE,
    ].join(" "),
    parameters: secret,
    background: false,
    recover: recover(daemon),
    run: (args, ctx) => {
      const label = args.label.trim();
      const reason = args.reason.trim();
      if (!label || !reason) return Effect.succeed(failed("Say what the secret is in `label` and what it's for in `reason`."));
      const url = args.url?.trim() ? safeUrl(args.url.trim()) : undefined;
      if (args.url?.trim() && !url) return Effect.succeed(failed("`url` must be an http(s) address."));
      const placeholder = args.placeholder?.trim();
      return ask(daemon, ctx, { kind: "secret", label, reason, ...(placeholder ? { placeholder } : {}), ...(url ? { url } : {}) });
    },
  }),
];
