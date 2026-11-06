/** `--seed N`: give the first bot an N-message history, to test cold start and scrolling on long transcripts. */
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { FAKE_PROMPTS, fakeAnswer } from "./fake-bots.ts";
import type { Store } from "./store.ts";

export function seedHistory(store: Store, bot: number, count: number) {
  if (store.lastSeq(bot) > 0) return; // only seed a fresh bot
  const start = Date.now() - count * 60_000;
  store.transaction(() => {
    for (let i = 0; i < count; i += 2) {
      const text = `${FAKE_PROMPTS[(i / 2) % FAKE_PROMPTS.length]} (#${i / 2 + 1})`;
      const at = start + i * 60_000;
      store.append(bot, "user", { role: "user", content: text, timestamp: at }, { requestId: `seed-${bot}-${i}`, at });
      store.append(bot, "assistant", { ...fauxAssistantMessage(fakeAnswer(text)), timestamp: at + 1_000 }, { at: at + 1_000 });
    }
  });
  console.log(`[top] seeded ${count} messages into bot ${bot}`);
}
