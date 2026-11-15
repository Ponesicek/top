/**
 * Stored entries → what a client receives. The client gets what it shows, not what the model saw:
 * no usage counters, provider metadata or tool arguments, and tool output cut to a preview. `detail`
 * fetches one entry in full when someone opens it.
 */
import type { Entry, ToolCallView } from "@top/protocol";
import { textOf } from "./messages.ts";
import type { StoredEntry } from "./store.ts";

export { textOf };

const TOOL_PREVIEW_CHARS = 280;
const ARGS_SUMMARY_CHARS = 100;

/** Tool arguments on one short line. */
export function summarize(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const text = Object.entries(args)
    .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join(", ")
    .replace(/\s+/g, " ");
  return text.length > ARGS_SUMMARY_CHARS ? `${text.slice(0, ARGS_SUMMARY_CHARS - 1)}…` : text;
}

/** The client's view of a stored entry; `undefined` for entries clients never see (system messages). */
export function toWire(stored: StoredEntry, full = false): Entry | undefined {
  const base = { seq: stored.seq, bot: stored.bot, at: stored.at };
  switch (stored.kind) {
    case "system":
      return undefined;
    case "notice":
      return { ...base, kind: "notice", text: stored.message.text };
    case "files":
      return { ...base, kind: "files", files: stored.message.files };
    case "user": {
      const { content, attachments } = stored.message;
      return {
        ...base,
        kind: "user",
        // What the user wrote: not the note telling the bot where their attachments are saved.
        text: textOf(typeof content === "string" ? content : content.filter((p) => !(p.type === "text" && p.attachmentNote))),
        ...(attachments?.length ? { attachments } : {}),
        ...(stored.requestId ? { requestId: stored.requestId } : {}),
        ...(stored.source ? { source: stored.source } : {}),
      };
    }
    case "assistant": {
      const message = stored.message;
      const parts = typeof message.content === "string" ? [] : message.content;
      const thinking = parts.flatMap((p) => (p.type === "thinking" ? [p.thinking] : [])).join("\n");
      const tools: ToolCallView[] = parts.flatMap((p) =>
        p.type === "toolCall" ? [{ id: p.id, name: p.name, summary: full ? JSON.stringify(p.arguments ?? {}) : summarize(p.arguments) }] : [],
      );
      const failed = message.stopReason === "error" || message.stopReason === "aborted";
      return {
        ...base,
        kind: "assistant",
        text: textOf(message.content),
        ...(tools.length ? { tools } : {}),
        ...(thinking ? (full ? { thinking } : { hasThinking: true as const }) : {}),
        ...(failed ? { error: message.errorMessage || message.stopReason } : {}),
        ...(message.stopReason === "aborted" ? { stopped: true as const } : {}),
      };
    }
    case "tool": {
      const message = stored.message;
      const text = textOf(message.content);
      const cut = !full && text.length > TOOL_PREVIEW_CHARS;
      return {
        ...base,
        kind: "tool",
        toolCallId: stored.toolCallId ?? message.toolCallId,
        name: message.toolName,
        text: cut ? `${text.slice(0, TOOL_PREVIEW_CHARS - 1)}…` : text,
        ...(cut ? { truncated: true as const } : {}),
        ...(message.isError ? { isError: true as const } : {}),
        ...(stored.outcome ? { outcome: stored.outcome } : {}),
      };
    }
  }
}
