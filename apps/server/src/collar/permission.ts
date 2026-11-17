import { MAX_PERMISSION_ACTION, MAX_PERMISSION_REASON, type PermissionAsk } from "@top/protocol";
import * as Effect from "effect/Effect";
import Type from "typebox";
import type { PermissionRow } from "../store.ts";
import { defineTool, type ToolResult, text } from "../tools.ts";
import type { CollarGroup } from "./index.ts";

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

function asked(row: PermissionRow): ToolResult {
  const permission: PermissionAsk = { id: row.id, action: row.action, ...(row.reason ? { reason: row.reason } : {}) };
  return {
    ...text(
      `Asked the user: ${row.action}. Their answer will come to you as a message. Until it does, don't do it: ` +
        "carry on with anything that doesn't need it, or end your turn.",
    ),
    details: { permission },
  };
}

export const permissionGroup: CollarGroup = (daemon) => [
  defineTool({
    name: "ask_permission",
    label: "Ask permission",
    description: [
      "Ask the user whether you may do something. The user sees your action and reason in the app and answers with Allow or Deny.",
      "You don't wait here: their answer comes to you later as a message, even when you're idle. If the user stops you first, the request is withdrawn and no answer comes; ask again if you still need to.",
      "Nothing enforces the answer: your tools work either way, so it's up to you to respect it. Don't do it unless it's allowed.",
    ].join(" "),
    parameters,
    background: false,
    recover: (_args, ctx) => Effect.map(daemon.permissions.askedBy(ctx.key), (row) => (row ? asked(row) : false)),
    run: (args, ctx) =>
      Effect.gen(function* () {
        const action = args.action.trim().replace(/\.+$/, "");
        if (!action) return { ...text("Say what you want to do in `action`."), isError: true };
        if (ctx.signal?.aborted) return { ...text("Not asked: stopped by the user."), isError: true };
        return asked(yield* daemon.permissions.ask(ctx.bot, ctx.key, action, args.reason?.trim() || undefined));
      }),
  }),
];
