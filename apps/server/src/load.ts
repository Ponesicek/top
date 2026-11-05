/** Synthetic load: every bot gets a new prompt shortly after it goes idle, so all of them stream at once. */
import { randomUUID } from "node:crypto";
import { withCancel } from "@earendil-works/chord/context";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";
import type { Bot } from "./bots.ts";
import { FAKE_PROMPTS } from "./fake-bots.ts";

export function startLoad(harness: Harness, bots: readonly Bot[]): () => void {
  const { context, cancel } = withCancel(BACKGROUND_CONTEXT);
  let stopped = false;
  for (const bot of bots) {
    void (async () => {
      const conversation = await harness.conversation(bot.id as never, context);
      if (!conversation) return;
      while (!stopped) {
        try {
          await conversation.waitForIdle(context);
          await new Promise((r) => setTimeout(r, 400 + Math.random() * 1600));
          if (stopped) return;
          const prompt = FAKE_PROMPTS[Math.floor(Math.random() * FAKE_PROMPTS.length)]!;
          const submission = await conversation.submit(
            { type: "input", content: prompt, requestId: `load-${randomUUID()}`, whenBusy: "reject" },
            context,
          );
          await submission.wait(context);
        } catch (error) {
          if (stopped) return;
          // Busy because a person messaged the bot first: wait for idle and try again.
          if ((error as Error).name !== "ConversationBusy") console.warn(`[load] ${bot.name}:`, (error as Error).message);
          await new Promise((r) => setTimeout(r, 500));
        }
      }
    })();
  }
  return () => {
    stopped = true;
    cancel();
  };
}
