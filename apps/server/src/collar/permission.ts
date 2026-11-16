/** `collar__ask_permission`: ask the user whether the bot may do something, and wait for the answer (see permissions.ts). */
import { MAX_PERMISSION_ACTION, MAX_PERMISSION_REASON } from "@top/protocol";
import * as Effect from "effect/Effect";
import Type from "typebox";
import { defineTool, stopped, text } from "../tools.ts";
import type { CollarGroup } from "./index.ts";
import { ASK_PERMISSION } from "./names.ts";

/** How the result starts, for the model and for clients reading a background job's message (`answerIn`). */
const ALLOWED = "Allowed by the user: ";
const DENIED = "Denied by the user: ";

/**
 * The answer in a background job's message about this tool, if it got one. The message is a header
 * line naming the call (its arguments squeezed onto that one line), a blank line, then the result.
 */
export function answerIn(message: string): "allowed" | "denied" | undefined {
  const [head = "", ...rest] = message.split("\n");
  if (!/^\[Background job \d+ finished\]/.test(head) || !head.includes(ASK_PERMISSION)) return undefined;
  const result = rest.join("\n").trimStart();
  return result.startsWith(ALLOWED) ? "allowed" : result.startsWith(DENIED) ? "denied" : undefined;
}

const parameters = Type.Object(
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

export const permissionGroup: CollarGroup = (daemon) => [
  defineTool({
    name: "ask_permission",
    label: "Ask permission",
    description: [
      "Ask the user whether you may do something, and get their answer: allowed or denied.",
      "The user sees your action and reason in the app and answers with Allow or Deny.",
      "Nothing enforces the answer: your tools work either way, so it's up to you to respect it. If it's denied, don't do it.",
      "If the user takes a while, the request moves to the background and the answer comes to you as a message.",
    ].join(" "),
    parameters,
    // A restart ends the request unanswered (`recover`): it's never asked again, and never taken as allowed.
    recover: () => Effect.succeed(false),
    run: (args, ctx) =>
      Effect.gen(function* () {
        // Its own words, without a closing full stop, so it reads well after "Allowed by the user:".
        const action = args.action.trim().replace(/\.+$/, "");
        if (!action) return { ...text("Say what you want to do in `action`."), isError: true };
        const allowed = yield* Effect.raceFirst(
          daemon.permissions.ask(ctx.bot, ctx.toolCallId ?? ctx.key, action, args.reason?.trim() || undefined),
          stopped(ctx.signal),
        );
        return allowed
          ? { ...text(`${ALLOWED}${action}.`), details: { permission: "allowed" } }
          : { ...text(`${DENIED}${action}. Don't do it.`), details: { permission: "denied" } };
      }),
  }),
];
