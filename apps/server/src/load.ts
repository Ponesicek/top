/** Synthetic load: every bot gets a new message shortly after it goes idle, so all of them work at once. */
import { randomUUID } from "node:crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Random from "effect/Random";
import { Daemon } from "./daemon.ts";
import { FAKE_PROMPTS, TOOL_PROMPTS } from "./fake-bots.ts";

/** Keep every bot busy until the scope closes. */
export const startLoad = (options: { tools: boolean }) =>
  Effect.gen(function* () {
    const daemon = yield* Daemon;
    const prompts: readonly string[] = options.tools ? [...FAKE_PROMPTS, ...TOOL_PROMPTS, ...TOOL_PROMPTS] : FAKE_PROMPTS;
    for (const runner of daemon.runners()) {
      const next = Effect.gen(function* () {
        yield* runner.waitForIdle;
        yield* Effect.sleep(Duration.millis(400 + (yield* Random.next) * 1600));
        const prompt = prompts[yield* Random.nextIntBetween(0, prompts.length)]!;
        yield* daemon.submit(runner.id, `load-${randomUUID()}`, prompt, "reject", "load").pipe(
          // Let the runner pick it up before waiting for idle again.
          Effect.andThen(Effect.sleep(Duration.millis(50))),
          Effect.catchTags({
            // Busy because a person messaged the bot first: wait for idle and try again.
            BusyError: () => Effect.sleep(Duration.millis(500)),
            AttachmentError: (error) => Effect.logWarning(`[load] ${runner.name}: ${error.message}`),
            // Deleted meanwhile: nothing more to load it with.
            UnknownBotError: () => Effect.interrupt,
          }),
        );
      });
      yield* Effect.forkScoped(Effect.forever(next));
    }
  });
