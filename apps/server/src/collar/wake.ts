/** `collar__wake`: set, list and cancel wake-ups (see wakes.ts). */
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import Type from "typebox";
import { duration, localTime } from "../time.ts";
import { defineTool, text } from "../tools.ts";
import type { CollarGroup } from "./index.ts";

/** Pending wake-ups one bot may have at once, so a confused bot can't pile them up. */
const MAX_PENDING = 50;
const MAX_AHEAD_MS = 366 * 24 * 60 * 60 * 1000;

const parameters = Type.Object(
  {
    action: Type.Optional(Type.Enum(["set", "list", "cancel"], { description: 'Default "set".' })),
    in_minutes: Type.Optional(Type.Number({ description: "set: wake up after this many minutes (fractions are fine)." })),
    at: Type.Optional(
      Type.String({
        description: 'set: wake up at this time instead, ISO 8601 such as "2026-11-07T09:00". Without an offset it is the computer\'s local time.',
      }),
    ),
    note: Type.Optional(Type.String({ description: "set: what to do when you wake up. It's all you'll get, so say enough to pick up where you left off." })),
    id: Type.Optional(Type.Integer({ description: "cancel: the wake-up's number." })),
  },
  { additionalProperties: false },
);

export const wakeGroup: CollarGroup = (daemon) => [
  defineTool({
    name: "wake",
    label: "Wake-up",
    description: [
      "Get a message from yourself later: to check on something, follow up, or carry on with work after a wait.",
      "Set a wake-up with `in_minutes` or `at` and a `note`, then end your turn. When it's due, your note comes to you as a message, even if the daemon restarted meanwhile.",
      "Use this to wait instead of sleeping in a command. You also don't need it for a slow tool call: one that runs long moves to the background, and its result comes to you by itself.",
      '`action: "list"` shows your wake-ups that haven\'t gone off; `action: "cancel"` with `id` removes one.',
    ].join(" "),
    parameters,
    // Setting is keyed by the call, so running it again sets nothing new; list and cancel only look or repeat.
    replay: "safe",
    background: false,
    run: (args, ctx) =>
      Effect.gen(function* () {
        const store = daemon.store;
        const action = args.action ?? "set";
        const now = yield* Clock.currentTimeMillis;
        if (action === "list") {
          const wakes = yield* store.wakes(ctx.bot);
          if (!wakes.length) return text(`No wake-ups set. It's ${localTime(now)}.`);
          const lines = wakes.map((w) => `- ${w.id}: ${localTime(w.dueAt)} (in ${duration(w.dueAt - now)}): ${w.note}`);
          return text(`It's ${localTime(now)}. Your wake-ups:\n${lines.join("\n")}`);
        }
        if (action === "cancel") {
          const id = args.id;
          if (id === undefined) return { ...text('Say which wake-up to cancel with `id` (see `action: "list"`).'), isError: true };
          const cancelled = yield* store.cancelWake(ctx.bot, id);
          yield* daemon.wakes.changed;
          yield* daemon.changed(ctx.bot);
          return cancelled ? text(`Cancelled wake-up ${id}.`) : { ...text(`You have no wake-up ${id} waiting.`), isError: true };
        }

        const note = (args.note ?? "").trim();
        if (!note) return { ...text("Give the wake-up a `note`: what to do when it goes off."), isError: true };
        let dueAt: number;
        if (args.in_minutes !== undefined) {
          const minutes = args.in_minutes;
          if (!Number.isFinite(minutes) || minutes < 0) return { ...text("`in_minutes` must be a number of minutes, 0 or more."), isError: true };
          dueAt = now + minutes * 60_000;
        } else if (args.at !== undefined) {
          dueAt = Date.parse(args.at);
          if (Number.isNaN(dueAt)) return { ...text(`Can't read the time "${args.at}". Use ISO 8601, such as 2026-11-07T09:00.`), isError: true };
          if (dueAt < now - 60_000) return { ...text(`${localTime(dueAt)} has passed; it's ${localTime(now)} now.`), isError: true };
        } else {
          return { ...text(`Say when: \`in_minutes\`, or \`at\`. It's ${localTime(now)} now.`), isError: true };
        }
        if (dueAt - now > MAX_AHEAD_MS) return { ...text("That's more than a year away; pick a nearer time."), isError: true };
        if ((yield* store.wakes(ctx.bot)).length >= MAX_PENDING) {
          return { ...text(`You already have ${MAX_PENDING} wake-ups waiting. Cancel some first (see \`action: "list"\`).`), isError: true };
        }
        const wake = yield* store.addWake(ctx.bot, ctx.key, Math.round(dueAt), note);
        yield* daemon.wakes.changed;
        yield* daemon.changed(ctx.bot);
        return text(
          `Wake-up ${wake.id} set for ${localTime(wake.dueAt)}, in ${duration(wake.dueAt - now)}. Your note will come to you as a message then; end your turn when you have nothing else to do.`,
        );
      }),
  }),
];
