import type { ToolCall } from "@earendil-works/pi-ai";
import { type TranscriptMessage, textOf } from "./messages.ts";

/**
 * The conversation so far as text, for a runtime that has none of it: a bot moved to another runtime, or a Claude bot
 * whose session is gone. It's made from Top's own record, the way T3 Code hands a thread to another agent: messages,
 * tool calls and their results, errors, but no tool or reasoning state and no attachments, newest first within a
 * budget, always keeping the first and the last exchange.
 */
export const HANDOFF_BYTES = 64_000;
const RESULT_CHARS = 2_000;
const ARGS_CHARS = 400;

type Item = { readonly index: number; readonly text: string };

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

function itemsOf(messages: readonly TranscriptMessage[]): Item[] {
  const calls = new Map<string, ToolCall>();
  const items: Item[] = [];
  messages.forEach((m, index) => {
    const when = new Date(m.timestamp).toISOString().slice(0, 16).replace("T", " ");
    switch (m.role) {
      case "user": {
        const text = textOf(m.content).trim();
        if (text) items.push({ index, text: `[History · user · ${when}]\n${text}` });
        return;
      }
      case "assistant": {
        for (const part of m.content) if (part.type === "toolCall") calls.set(part.id, part);
        const text = textOf(m.content.filter((part) => part.type === "text")).trim();
        if (m.stopReason === "error" || m.stopReason === "aborted")
          items.push({ index, text: `[History · ${m.stopReason === "error" ? "error" : "stopped"} · ${when}]\n${m.errorMessage ?? ""}`.trim() });
        else if (text) items.push({ index, text: `[History · you · ${when}]\n${text}` });
        return;
      }
      case "toolResult": {
        const call = calls.get(m.toolCallId);
        const args = call ? ` ${clip(JSON.stringify(call.arguments), ARGS_CHARS)}` : "";
        items.push({
          index,
          text: `[History · tool ${m.toolName}${args}${m.isError ? " · error" : ""} · ${when}]\n${clip(textOf(m.content), RESULT_CHARS)}`,
        });
        return;
      }
      case "system":
        return;
    }
  });
  return items;
}

/** The handoff text, or nothing when there's no conversation to hand over. */
export function handoffDocument(messages: readonly TranscriptMessage[], why: string, budget = HANDOFF_BYTES): string | undefined {
  const items = itemsOf(messages);
  if (!items.length) return undefined;
  const size = (item: Item) => Buffer.byteLength(item.text) + 2;
  const chosen = new Set<Item>();
  let used = 0;
  const take = (item: Item | undefined) => {
    if (!item || chosen.has(item)) return;
    chosen.add(item);
    used += size(item);
  };
  // The first message (what the conversation is about) and the last exchange always go, then the newest that fit.
  take(items.find((item) => messages[item.index]!.role === "user"));
  take(items.findLast((item) => messages[item.index]!.role === "user"));
  take(items.findLast((item) => messages[item.index]!.role === "assistant"));
  for (let i = items.length - 1; i >= 0; i--) if (!chosen.has(items[i]!) && used + size(items[i]!) <= budget) take(items[i]);
  const kept = items.filter((item) => chosen.has(item));
  return [
    `[Top: context handoff. ${why} This is the conversation so far, from Top's record of it: history, not a new request. Tool and reasoning state and attached files aren't carried over; the user still sees everything in the app.]`,
    `[${kept.length} of ${items.length} items${kept.length < items.length ? "; older ones that didn't fit are left out" : ""}.]`,
    ...kept.map((item) => item.text),
    "[End of the handoff.]",
  ].join("\n\n");
}
