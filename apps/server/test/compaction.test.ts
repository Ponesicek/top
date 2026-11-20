import assert from "node:assert/strict";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import { test } from "vitest";
import { CompactAtTokens, compactionCut, compactLimit, contextTokens, cutIndex, SUMMARY_HEAD, SUMMARY_REQUEST, summaryMessage } from "../src/compaction.ts";
import type { Context } from "../src/fake-bots.ts";
import { DEFAULT_MODEL } from "../src/installation.ts";
import { type TranscriptMessage, textOf } from "../src/messages.ts";
import { harness, idle, until } from "./harness.ts";

const system: TranscriptMessage = { role: "system", content: "You are Atlas.", timestamp: 1 };
const user = (text: string, timestamp = 2): TranscriptMessage => ({ role: "user", content: text, timestamp });
const answer = (text: string, prompt = 0, timestamp = 3): AssistantMessage => ({
  ...fauxAssistantMessage(text),
  timestamp,
  usage: {
    input: prompt,
    output: 10,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: prompt + 10,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
});
const call = (timestamp = 3): AssistantMessage => ({ ...answer("", 0, timestamp), content: [fauxToolCall("bash", { command: "ls" }, { id: "c1" })] });
const result: TranscriptMessage = {
  role: "toolResult",
  toolCallId: "c1",
  toolName: "bash",
  content: [{ type: "text", text: "a b" }],
  isError: false,
  timestamp: 4,
};

test("the cut keeps what the bot hasn't answered, and a tool call with its results", () => {
  assert.equal(cutIndex([system, user("hi"), answer("hello"), user("next")]), 3);
  assert.equal(cutIndex([system, user("hi"), answer("hello")]), 3);
  assert.equal(cutIndex([system, user("hi"), call(), result]), 2);
  assert.equal(cutIndex([system, summaryMessage("s", 5), call(6), result]), undefined);
  assert.equal(cutIndex([system, user("hi")]), undefined);
});

test("the transcript's size is the last answer's count plus what came after, never an answer from before the summary", () => {
  const after = user("x".repeat(400));
  assert.equal(contextTokens([system, user("hi"), answer("hello", 5_000), after]), 5_010 + 100);
  const estimated = contextTokens([system, summaryMessage("short", 10), answer("hello", 5_000, 3), after]);
  assert.ok(estimated < 200, `estimated ${estimated}`);
  assert.equal(contextTokens([system, summaryMessage("short", 10), answer("hello", 700, 11), after]), 710 + 100);
});

test("a transcript is compacted when it's over the limit, and again only once half the limit is new", () => {
  const long = (timestamp: number): AssistantMessage => ({ ...answer("x".repeat(4_000), 0, timestamp), usage: { ...answer("").usage, output: 0 } });
  assert.equal(compactionCut([system, user("hi"), answer("hello", 500)], 1_000), undefined, "under the limit");
  assert.deepEqual(compactionCut([system, user("hi"), answer("hello", 5_000)], 1_000), { cut: 3, tokens: 5_010 });
  const summary = summaryMessage("y".repeat(8_000), 5);
  assert.equal(compactionCut([system, summary, long(6)], 2_500), undefined);
  assert.equal(compactionCut([system, summary, long(6), long(7)], 2_500)?.cut, 4);
});

test("a bot on the default model is compacted past 120k tokens, unless TOP_COMPACT_AT_TOKENS says otherwise or 80% of the window is less", () => {
  const atTokens = (env: Record<string, string>) => Effect.runSync(Effect.provide(CompactAtTokens, ConfigProvider.layer(ConfigProvider.fromEnv({ env }))));
  assert.equal(atTokens({}), 120_000);
  assert.equal(atTokens({ TOP_COMPACT_AT_TOKENS: "90000" }), 90_000);
  const [provider, id] = DEFAULT_MODEL.split("/") as [string, string];
  const model = builtinModels().getModel(provider, id);
  assert.ok(model, `pi-ai lists ${DEFAULT_MODEL}`);
  assert.equal(DEFAULT_MODEL, "openai/gpt-6.2-sol");
  const limit = compactLimit(atTokens({}), model.contextWindow);
  assert.equal(limit, 120_000);
  assert.equal(compactionCut([system, user("hi"), answer("hello", 119_990)], limit!), undefined, "120,000 tokens fit");
  assert.equal(compactionCut([system, user("hi"), answer("hello", 119_991)], limit!)?.tokens, 120_001);
  assert.equal(compactLimit(120_000, 128_000), 102_400, "a smaller window leaves 20% for the answer");
  assert.equal(compactLimit(120_000, 0), 120_000, "a model with no window given");
  assert.equal(compactLimit(0, 272_000), undefined, "0 turns compaction off");
});

test("a long transcript is summarised before the next request, from the cache, and the bot goes on from the summary", async () => {
  const requests: Context[] = [];
  const h = await harness({ compactAtTokens: 1_500, onRequest: (context) => requests.push(context) });
  const send = async (n: number) => {
    await h.run(h.daemon.submit(h.bot, `r${n}`, `Question ${n}: tell me about topic ${n}`, "followUp", null, []));
    await until(`answer ${n}`, async () => (await idle(h)) && (await h.entries()).at(-1)?.kind === "assistant");
  };
  const compacted = async () => (await h.entries()).filter((e) => e.kind === "notice" && /^Compacted the conversation/.test(e.message.text));

  let n = 0;
  while (!(await compacted()).length) {
    assert.ok(++n <= 12, "it compacts within a dozen messages");
    await send(n);
  }

  const at = requests.findIndex((r) => textOf(r.messages.at(-1)?.content as never) === SUMMARY_REQUEST);
  const [before, summarising, next] = [requests[at - 1]!, requests[at]!, requests[at + 1]!];
  assert.deepEqual(summarising.messages.slice(0, before.messages.length), before.messages, "it starts as the last request did");
  const compaction = (await h.run(h.store.context(h.bot))).find((m) => m.role === "user" && textOf(m.content).startsWith(SUMMARY_HEAD));
  assert.ok(compaction, "the summary stands in the context");
  const stored = (await h.run(h.store.after(h.bot, 0, 1_000))).length;
  assert.ok(stored > 0);

  assert.deepEqual(
    next.messages.map((m) => m.role),
    [...before.messages.filter((m) => m.role === "system").map(() => "system"), "user", "user"],
  );
  assert.ok(textOf(next.messages.at(-2)!.content as never).startsWith(SUMMARY_HEAD));
  assert.equal(textOf(next.messages.at(-1)!.content as never), `Question ${n}: tell me about topic ${n}`);

  const shown = await h.entries();
  assert.equal(shown.filter((e) => e.kind === "user").length, n);
  assert.ok(!shown.some((e) => (e.kind as string) === "compaction"));

  await send(n + 1);
  assert.equal((await compacted()).length, 1);
});

test("the summary survives a restart", async () => {
  const h = await harness({ compactAtTokens: 1_500 });
  let n = 0;
  const compacted = async () => (await h.entries()).some((e) => e.kind === "notice" && /^Compacted/.test(e.message.text));
  while (!(await compacted())) {
    assert.ok(++n <= 12);
    await h.run(h.daemon.submit(h.bot, `r${n}`, `Question ${n}`, "followUp", null, []));
    await until(`answer ${n}`, async () => (await idle(h)) && (await h.entries()).at(-1)?.kind === "assistant");
  }
  const context = await h.run(h.store.context(h.bot));
  await h.close();
  const again = await harness({ dir: h.dir, compactAtTokens: 1_500 });
  assert.deepEqual(await again.run(again.store.context(again.bot)), context);
});
