/** `--seed N`: give the first bot an N-message history, to test cold start and scrolling on long transcripts. */
import type { Context } from "@earendil-works/chord";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { Harness } from "@earendil-works/pi-durable";
import { MESSAGE_KIND, type MessageData } from "@top/protocol";
import type { Bot } from "./bots.ts";
import { fakeAnswer, FAKE_PROMPTS } from "./fake-bots.ts";

export async function seedHistory(harness: Harness, bot: Bot, count: number, context: Context) {
  const conversation = await harness.conversation(bot.id as never, context);
  if (!conversation) return;
  const existing = await conversation.entries({}, 1, undefined, context);
  if (existing.items.length > 0) return; // only seed a fresh bot
  const batch = 500;
  for (let start = 0; start < count; start += batch) {
    await conversation.commit(async (tx) => {
      for (let i = start; i < Math.min(count, start + batch); i += 2) {
        const text = `${FAKE_PROMPTS[(i / 2) % FAKE_PROMPTS.length]} (#${i / 2 + 1})`;
        const timestamp = Date.now() - (count - i) * 60_000;
        await tx.appendEntry(conversation.id, {
          kind: MESSAGE_KIND,
          data: { requestId: `seed-${i}`, text, clientId: "seed" } satisfies MessageData,
          model: [{ role: "user", content: text, timestamp }],
        });
        await tx.appendEntry(conversation.id, {
          kind: "pi.assistant",
          model: [{ ...fauxAssistantMessage(fakeAnswer(text)), timestamp: timestamp + 1_000 } as never],
        });
      }
    }, context);
  }
  console.log(`[top] seeded ${count} messages into ${bot.name}`);
}
