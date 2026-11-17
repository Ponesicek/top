/**
 * Compaction: when a bot's transcript gets long, the model summarises it and the summary stands in for
 * it from then on. Every turn sends the whole transcript, so a bot with a long one pays for all of it on
 * every request, cached or not; compaction keeps that bounded.
 *
 * - Before a model request, if the transcript is over `compactAtTokens` (estimated from the last
 *   answer's usage), the loop compacts it first (loop.ts).
 * - What's summarised is everything up to the bot's last answer. What came after it stays word for
 *   word: the messages it hasn't answered yet, or its tool calls still running and their results.
 * - The summary request is the transcript as the bot sends it, cut there, plus a request for the
 *   summary: it starts the same as the bot's last request, so the provider's prompt cache covers it.
 * - The store keeps everything (the app still shows the whole history). A `compaction` entry records
 *   the summary and the first entry kept; the model's context is then the system messages (its
 *   instructions and tools, as before, so the start of the prompt still hits the cache), the summary,
 *   and the entries from the first one kept on (store.ts).
 */
import type { AssistantMessage, ImageContent, TextContent } from "@earendil-works/pi-ai";
import * as Config from "effect/Config";
import type { TopUserMessage, TranscriptMessage } from "./messages.ts";

/** A transcript longer than this (in tokens) is compacted before the next request (`TOP_COMPACT_AT_TOKENS`; 0 turns it off). */
export const CompactAtTokens = Config.Int("TOP_COMPACT_AT_TOKENS").pipe(Config.withDefault(120_000));
/** Never wait past this share of the model's context window. */
export const WINDOW_SHARE = 0.8;

/** What the model is asked, after its transcript, for the summary. */
export const SUMMARY_REQUEST = [
  "Your conversation has grown long, so it's being compacted: everything above will be replaced by a summary you write now, and you'll carry on from that summary alone. Write it for yourself. Don't call tools; answer with the summary only.",
  "",
  "Use this format:",
  "",
  "## Goal",
  "What the user wants from you, overall and right now.",
  "",
  "## The user's words",
  "Their requests and preferences that still matter. Quote their latest request word for word if it isn't done.",
  "",
  "## Done",
  "",
  "## In progress",
  "",
  "## Waiting on",
  "Background jobs and wake-ups with their numbers, other agents and threads with their ids, and what you expect from each.",
  "",
  "## Facts to keep",
  "Exact ids, paths, branch and PR numbers, URLs, commands and errors you'll need. Write them out; don't describe them.",
  "",
  "## Next steps",
  "",
  "Be brief: keep what you need to carry on, and drop what's finished and no longer matters.",
].join("\n");

/** How the summary opens, where it stands in for the transcript. */
export const SUMMARY_HEAD =
  "[Summary of the conversation so far] Your earlier conversation was compacted to save space, and this summary, which you wrote, replaced it.";

/** The summary as it stands in the transcript: a user message, marked so the loop can tell it apart. */
export interface SummaryMessage extends TopUserMessage {
  readonly compaction: true;
}

export const summaryMessage = (summary: string, timestamp: number): SummaryMessage => ({
  role: "user",
  content: `${SUMMARY_HEAD}\n\n${summary}`,
  timestamp,
  compaction: true,
});

const isSummary = (message: TranscriptMessage): boolean => "compaction" in message && message.compaction === true;

/** Characters an image counts for in an estimate. */
const IMAGE_CHARS = 4_800;

const contentChars = (content: string | readonly (TextContent | ImageContent | { type: string })[]) =>
  typeof content === "string"
    ? content.length
    : content.reduce((sum, part) => sum + ("text" in part && typeof part.text === "string" ? part.text.length : part.type === "image" ? IMAGE_CHARS : 0), 0);

/** A message's size in tokens, roughly (4 characters each; on the high side). */
export function estimateTokens(message: TranscriptMessage): number {
  let chars = 0;
  switch (message.role) {
    case "system":
      chars = contentChars(message.content) + JSON.stringify(message.sections ?? {}).length + JSON.stringify(message.toolsAdded ?? []).length;
      break;
    case "user":
    case "toolResult":
      chars = contentChars(message.content);
      break;
    case "assistant":
      for (const part of message.content) {
        if (part.type === "text") chars += part.text.length;
        else if (part.type === "thinking") chars += part.thinking.length;
        else if (part.type === "toolCall") chars += part.name.length + JSON.stringify(part.arguments ?? {}).length;
      }
      break;
  }
  return Math.ceil(chars / 4);
}

/** The prompt one answer took, as the provider counted it: 0 when it didn't say. */
const promptTokens = (answer: AssistantMessage) => {
  const usage = answer.usage as Partial<AssistantMessage["usage"]> | undefined;
  return (usage?.input ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0) + (usage?.output ?? 0);
};

/**
 * The transcript's size in tokens: the last answer's prompt and output as the provider counted them,
 * plus an estimate of what came after. An answer from before the last compaction (also one kept word
 * for word after the summary) counted a transcript that's gone, so then it's all estimated.
 */
export function contextTokens(messages: readonly TranscriptMessage[]): number {
  const summaryAt = messages.findLastIndex(isSummary);
  const since = summaryAt === -1 ? Number.NEGATIVE_INFINITY : messages[summaryAt]!.timestamp;
  for (let i = messages.length - 1; i > summaryAt; i--) {
    const message = messages[i]!;
    if (message.role !== "assistant" || message.stopReason === "error" || message.stopReason === "aborted" || message.timestamp < since) continue;
    const counted = promptTokens(message);
    if (counted > 0) return counted + messages.slice(i + 1).reduce((sum, m) => sum + estimateTokens(m), 0);
  }
  return messages.reduce((sum, m) => sum + estimateTokens(m), 0);
}

/**
 * Where to cut: the index of the first message kept word for word, or `undefined` when there's nothing
 * new to summarise. It's just after the last answer, or at it when its tool calls' results follow
 * (a call and its result stay together).
 */
export function cutIndex(messages: readonly TranscriptMessage[]): number | undefined {
  const last = messages.findLastIndex((m) => m.role === "assistant");
  if (last === -1) return undefined;
  const cut = messages.slice(last + 1).some((m) => m.role === "toolResult") ? last : last + 1;
  const summaryAt = messages.findLastIndex(isSummary);
  // Something besides system messages since the last summary, before the cut.
  const fresh = messages.slice(summaryAt + 1, cut).some((m) => m.role !== "system");
  return fresh ? cut : undefined;
}

/**
 * Where to cut a transcript that's over `atTokens` (see `cutIndex`), or `undefined` when it isn't
 * due. Half the limit must be new since the last summary, so a summary that came out long isn't
 * compacted again on every request.
 */
export function compactionCut(messages: readonly TranscriptMessage[], atTokens: number): { cut: number; tokens: number } | undefined {
  const tokens = contextTokens(messages);
  if (tokens <= atTokens) return undefined;
  const summarised = messages.slice(0, messages.findLastIndex(isSummary) + 1).reduce((sum, m) => sum + estimateTokens(m), 0);
  if (tokens - summarised < atTokens / 2) return undefined;
  const cut = cutIndex(messages);
  return cut === undefined ? undefined : { cut, tokens };
}

/** "312k", for the notice. */
export const kTokens = (tokens: number) =>
  tokens >= 10_000 ? `${Math.round(tokens / 1000)}k` : tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
