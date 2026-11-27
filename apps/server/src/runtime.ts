import type { Api, Model, Models } from "@earendil-works/pi-ai";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { type LoopOptions, runLoop } from "./loop.ts";
import type { TopAssistantMessage, TranscriptMessage } from "./messages.ts";

/**
 * What runs a bot's turns. Top keeps the transcript the apps show, the inbox, the tool records and their crash
 * policies, whatever runs the model; a runtime takes a turn's new messages and drives the model and its tool calls
 * through `options.hooks`.
 *
 * - `top`: Top's own loop on pi-ai. The transcript in `options.messages` is what the model sees.
 * - `claude`: the Claude Agent SDK, driving the Claude Code CLI installed on the daemon's computer and its sign-in.
 *   Claude Code keeps the conversation the model sees (its session); Top's transcript is the record of it.
 */
export type RuntimeId = "top" | "claude";

export type TurnOptions = Omit<LoopOptions, "models" | "model">;

export type BotRuntime = {
  readonly id: RuntimeId;
  /** The model's context window, when Top compacts the conversation itself (only Top's own loop: Claude Code compacts its own). */
  readonly contextWindow?: number | undefined;
  /** Whether a failed model request is worth Top asking again. Claude Code retries its own requests first. */
  readonly retries: boolean;
  /** Runs a turn: the prompts given (or none, to carry on after a restart or a retry), then whatever they lead to. */
  readonly turn: (options: TurnOptions, prompts?: readonly TranscriptMessage[]) => Effect.Effect<void>;
};

export const topRuntime = (models: Models, model: Model<Api>): BotRuntime => ({
  id: "top",
  contextWindow: model.contextWindow,
  retries: true,
  turn: (options, prompts) => runLoop({ ...options, models, model }, prompts),
});

/** Bots whose model is `claude/<model>` run on Claude Code; every other model is a pi-ai model on Top's own loop. */
export const CLAUDE_PROVIDER = "claude";

export const runtimeOf = (model: string): RuntimeId => (model.slice(0, model.indexOf("/")) === CLAUDE_PROVIDER ? "claude" : "top");

/** For a bot whose runtime this daemon can't run: each turn takes the user's messages and fails, saying why. */
export const unavailable = (why: string): BotRuntime => ({
  id: "claude",
  retries: false,
  turn: (options, prompts) =>
    Effect.gen(function* () {
      for (const message of prompts ?? []) {
        options.messages.push(message);
        yield* options.hooks.added(message);
      }
      const failed: TopAssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "" }],
        api: "claude-agent-sdk",
        provider: CLAUDE_PROVIDER,
        model: "",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "error",
        errorMessage: why,
        timestamp: yield* Clock.currentTimeMillis,
      };
      options.messages.push(failed);
      yield* options.hooks.added(failed);
    }),
});
