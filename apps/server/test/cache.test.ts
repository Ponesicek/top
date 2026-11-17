/** Prompt caching: every request of a bot goes out under that bot's own cache key, so it reaches its cache. */
import assert from "node:assert/strict";
import { test } from "vitest";
import { cacheKey } from "../src/runner.ts";
import { harness, idle, until } from "./harness.ts";

test("each bot's requests carry its own cache key, the same on every request", async () => {
  const sent: (string | undefined)[] = [];
  const h = await harness({ bots: ["Atlas", "Bea"], onRequest: (_context, options) => sent.push(options?.sessionId) });
  const [atlas, bea] = h.bots as [number, number];

  // A tool call (to a tool the bot doesn't have) and the answer after it: two requests in one task.
  await h.run(h.daemon.submit(atlas, "r1", "deploy web", "followUp", null, []));
  await until("Atlas to finish", () => idle(h, atlas));
  await h.run(h.daemon.submit(bea, "r2", "hello", "followUp", null, []));
  await until("Bea to finish", () => idle(h, bea));

  assert.deepEqual(sent, [cacheKey(atlas), cacheKey(atlas), cacheKey(bea)]);
  assert.notEqual(cacheKey(atlas), cacheKey(bea));
});
