/** Synthetic load: every bot gets a new message shortly after it goes idle, so all of them work at once. */
import { randomUUID } from "node:crypto";
import type { Daemon } from "./daemon.ts";
import { FAKE_PROMPTS, TOOL_PROMPTS } from "./fake-bots.ts";

export function startLoad(daemon: Daemon, options: { tools: boolean }): () => void {
  let stopped = false;
  const prompts: readonly string[] = options.tools ? [...FAKE_PROMPTS, ...TOOL_PROMPTS, ...TOOL_PROMPTS] : FAKE_PROMPTS;
  for (const runner of daemon.runners.values()) {
    void (async () => {
      while (!stopped) {
        await runner.waitForIdle();
        await new Promise((r) => setTimeout(r, 400 + Math.random() * 1600));
        if (stopped) return;
        const prompt = prompts[Math.floor(Math.random() * prompts.length)]!;
        try {
          daemon.submit(runner.id, `load-${randomUUID()}`, prompt, "reject", "load");
          // Let the runner pick it up before waiting for idle again.
          await new Promise((r) => setTimeout(r, 50));
        } catch (error) {
          // Busy because a person messaged the bot first: wait for idle and try again.
          if ((error as Error).name !== "ConversationBusy") console.warn(`[load] ${runner.name}:`, (error as Error).message);
          await new Promise((r) => setTimeout(r, 500));
        }
      }
    })();
  }
  return () => {
    stopped = true;
  };
}
