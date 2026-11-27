import type { AssistantMessage, ImageContent, TextContent } from "@earendil-works/pi-ai";
import * as Config from "effect/Config";
import type { TopUserMessage, TranscriptMessage } from "./messages.ts";

export const CompactAtTokens = Config.Int("TOP_COMPACT_AT_TOKENS").pipe(Config.withDefault(120_000));
const WINDOW_SHARE = 0.8;

/** Where a bot's conversation is compacted: at `atTokens`, but never past 80% of the model's window, leaving room for the answer. */
export const compactLimit = (atTokens: number | undefined, contextWindow: number): number | undefined =>
  atTokens && atTokens > 0 ? Math.min(atTokens, contextWindow > 0 ? Math.floor(contextWindow * WINDOW_SHARE) : Number.POSITIVE_INFINITY) : undefined;

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

export const SUMMARY_HEAD =
  "[Summary of the conversation so far] Your earlier conversation was compacted to save space, and this summary, which you wrote, replaced it.";

export interface SummaryMessage extends TopUserMessage {
  readonly compaction: true;
  /** Top's handoff from another runtime (handoff.ts) rather than the model's own summary. */
  readonly handoff?: true;
}

/** A handoff (a bot moved to Top's loop from another runtime) is its own text: Top wrote it, not the model. */
export const summaryMessage = (summary: string, timestamp: number, handoff = false): SummaryMessage => ({
  role: "user",
  content: handoff ? summary : `${SUMMARY_HEAD}\n\n${summary}`,
  timestamp,
  compaction: true,
  ...(handoff ? { handoff: true as const } : {}),
});

export const isSummary = (message: TranscriptMessage): message is SummaryMessage => "compaction" in message && message.compaction === true;

const IMAGE_CHARS = 4_800;

const contentChars = (content: string | readonly (TextContent | ImageContent | { type: string })[]) =>
  typeof content === "string"
    ? content.length
    : content.reduce((sum, part) => sum + ("text" in part && typeof part.text === "string" ? part.text.length : part.type === "image" ? IMAGE_CHARS : 0), 0);

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

const promptTokens = (answer: AssistantMessage) => {
  const usage = answer.usage as Partial<AssistantMessage["usage"]> | undefined;
  return (usage?.input ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0) + (usage?.output ?? 0);
};

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

export function cutIndex(messages: readonly TranscriptMessage[]): number | undefined {
  const last = messages.findLastIndex((m) => m.role === "assistant");
  if (last === -1) return undefined;
  const cut = messages.slice(last + 1).some((m) => m.role === "toolResult") ? last : last + 1;
  const summaryAt = messages.findLastIndex(isSummary);
  const fresh = messages.slice(summaryAt + 1, cut).some((m) => m.role !== "system");
  return fresh ? cut : undefined;
}

export function compactionCut(messages: readonly TranscriptMessage[], atTokens: number): { cut: number; tokens: number } | undefined {
  const tokens = contextTokens(messages);
  if (tokens <= atTokens) return undefined;
  const summarised = messages.slice(0, messages.findLastIndex(isSummary) + 1).reduce((sum, m) => sum + estimateTokens(m), 0);
  if (tokens - summarised < atTokens / 2) return undefined;
  const cut = cutIndex(messages);
  return cut === undefined ? undefined : { cut, tokens };
}

export const kTokens = (tokens: number) =>
  tokens >= 10_000 ? `${Math.round(tokens / 1000)}k` : tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
