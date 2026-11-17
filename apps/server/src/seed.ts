import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { FAKE_PROMPTS, fakeAnswer } from "./fake-bots.ts";
import { Store } from "./store.ts";

export const seedHistory = (bot: number, count: number) =>
  Effect.gen(function* () {
    const store = yield* Store;
    if ((yield* store.lastSeq(bot)) > 0) return;
    const start = (yield* Clock.currentTimeMillis) - count * 60_000;
    yield* store.transaction(
      Effect.gen(function* () {
        for (let i = 0; i < count; i += 2) {
          const text = `${FAKE_PROMPTS[(i / 2) % FAKE_PROMPTS.length]} (#${i / 2 + 1})`;
          const at = start + i * 60_000;
          yield* store.append(bot, "user", { role: "user", content: text, timestamp: at }, { requestId: `seed-${bot}-${i}`, at });
          yield* store.append(bot, "assistant", { ...fauxAssistantMessage(fakeAnswer(text)), timestamp: at + 1_000 }, { at: at + 1_000 });
        }
      }),
    );
    yield* Effect.log(`seeded ${count} messages into bot ${bot}`);
  });
