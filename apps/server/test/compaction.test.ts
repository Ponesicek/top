/**
 * Compaction: a bot whose transcript grew past the limit has it summarised before its next request,
 * keeps what it hasn't answered word for word, and goes on from the summary; the user still sees it all.
 */
import assert from "node:assert/strict";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { test } from "vitest";
import { compactionCut, contextTokens, cutIndex, SUMMARY_HEAD, SUMMARY_REQUEST, summaryMessage } from "../src/compaction.ts";
import type { Context } from "../src/fake-bots.ts";
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
  // New messages after the last answer stay.
  assert.equal(cutIndex([system, user("hi"), answer("hello"), user("next")]), 3);
  // Nothing after the last answer: everything is summarised.
  assert.equal(cutIndex([system, user("hi"), answer("hello")]), 3);
  // Calls still being answered stay with their results.
  assert.equal(cutIndex([system, user("hi"), call(), result]), 2);
  // Nothing new since the last summary, or no answer at all: nothing to do.
  assert.equal(cutIndex([system, summaryMessage("s", 5), call(6), result]), undefined);
  assert.equal(cutIndex([system, user("hi")]), undefined);
});

test("the transcript's size is the last answer's count plus what came after, never an answer from before the summary", () => {
  const after = user("x".repeat(400));
  assert.equal(contextTokens([system, user("hi"), answer("hello", 5_000), after]), 5_010 + 100);
  // An answer kept word for word after a summary counted the transcript that was replaced: estimate instead.
  const estimated = contextTokens([system, summaryMessage("short", 10), answer("hello", 5_000, 3), after]);
  assert.ok(estimated < 200, `estimated ${estimated}`);
  // One after the summary counts again.
  assert.equal(contextTokens([system, summaryMessage("short", 10), answer("hello", 700, 11), after]), 710 + 100);
});

test("a transcript is compacted when it's over the limit, and again only once half the limit is new", () => {
  // 1,000 tokens each, estimated (no usage).
  const long = (timestamp: number): AssistantMessage => ({ ...answer("x".repeat(4_000), 0, timestamp), usage: { ...answer("").usage, output: 0 } });
  assert.equal(compactionCut([system, user("hi"), answer("hello", 500)], 1_000), undefined, "under the limit");
  assert.deepEqual(compactionCut([system, user("hi"), answer("hello", 5_000)], 1_000), { cut: 3, tokens: 5_010 });
  // A summary of 2,000 tokens, then 1,000 more: over the limit, but only 1,000 new; with 1,000 more, it's due.
  const summary = summaryMessage("y".repeat(8_000), 5);
  assert.equal(compactionCut([system, summary, long(6)], 2_500), undefined);
  assert.equal(compactionCut([system, summary, long(6), long(7)], 2_500)?.cut, 4);
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

  // The summary request: the transcript as the bot sends it, up to its last answer, then the request for the summary.
  const at = requests.findIndex((r) => textOf(r.messages.at(-1)?.content as never) === SUMMARY_REQUEST);
  const [before, summarising, next] = [requests[at - 1]!, requests[at]!, requests[at + 1]!];
  assert.deepEqual(summarising.messages.slice(0, before.messages.length), before.messages, "it starts as the last request did");
  const compaction = (await h.run(h.store.context(h.bot))).find((m) => m.role === "user" && textOf(m.content).startsWith(SUMMARY_HEAD));
  assert.ok(compaction, "the summary stands in the context");
  const stored = (await h.run(h.store.after(h.bot, 0, 1_000))).length;
  assert.ok(stored > 0);

  // The next request: the system messages, the summary, then the message that came in, word for word.
  assert.deepEqual(
    next.messages.map((m) => m.role),
    [...before.messages.filter((m) => m.role === "system").map(() => "system"), "user", "user"],
  );
  assert.ok(textOf(next.messages.at(-2)!.content as never).startsWith(SUMMARY_HEAD));
  assert.equal(textOf(next.messages.at(-1)!.content as never), `Question ${n}: tell me about topic ${n}`);

  // The user still sees every message; the summary itself isn't shown.
  const shown = await h.entries();
  assert.equal(shown.filter((e) => e.kind === "user").length, n);
  assert.ok(!shown.some((e) => (e.kind as string) === "compaction"));

  // And the bot carries on from the summary: no compaction again right away.
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
