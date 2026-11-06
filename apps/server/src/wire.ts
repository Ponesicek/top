/**
 * Stored entries → what a client receives. The client gets what it shows, not what the model saw:
 * no usage counters, provider metadata or tool arguments, and tool output cut to a preview. `detail`
 * fetches one entry in full when someone opens it.
 */
import type { Entry, FileChange, ToolCallView } from "@top/protocol";
import type { StoredEntry } from "./store.ts";

const TOOL_PREVIEW_CHARS = 280;
const ARGS_SUMMARY_CHARS = 100;

type Part = { type: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: unknown };
type Message = { role?: string; content?: string | Part[]; stopReason?: string; errorMessage?: string; isError?: boolean; toolName?: string; text?: string };

export function textOf(content: Message["content"]): string {
  if (typeof content === "string") return content;
  return (content ?? []).map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("");
}

/** Tool arguments on one short line. */
export function summarize(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const text = Object.entries(args as Record<string, unknown>)
    .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join(", ")
    .replace(/\s+/g, " ");
  return text.length > ARGS_SUMMARY_CHARS ? `${text.slice(0, ARGS_SUMMARY_CHARS - 1)}…` : text;
}

/** The client's view of a stored entry; `undefined` for entries clients never see (system messages). */
export function toWire(stored: StoredEntry, full = false): Entry | undefined {
  const base = { seq: stored.seq, bot: stored.bot, at: stored.at };
  const message = JSON.parse(stored.message) as Message;
  switch (stored.kind) {
    case "system":
      return undefined;
    case "notice":
      return { ...base, kind: "notice", text: String(message.text ?? "") };
    case "files":
      return { ...base, kind: "files", files: (message as { files?: FileChange[] }).files ?? [] };
    case "user":
      return {
        ...base,
        kind: "user",
        text: textOf(message.content),
        ...(stored.requestId ? { requestId: stored.requestId } : {}),
        ...(stored.source ? { source: stored.source } : {}),
      };
    case "assistant": {
      const parts = typeof message.content === "string" ? [] : (message.content ?? []);
      const thinking = parts
        .filter((p) => p.type === "thinking")
        .map((p) => p.thinking ?? "")
        .join("\n");
      const tools: ToolCallView[] = parts
        .filter((p) => p.type === "toolCall")
        .map((p) => ({ id: String(p.id), name: String(p.name), summary: full ? JSON.stringify(p.arguments ?? {}) : summarize(p.arguments) }));
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
      const text = textOf(message.content);
      const cut = !full && text.length > TOOL_PREVIEW_CHARS;
      return {
        ...base,
        kind: "tool",
        toolCallId: stored.toolCallId ?? "",
        name: String(message.toolName ?? ""),
        text: cut ? `${text.slice(0, TOOL_PREVIEW_CHARS - 1)}…` : text,
        ...(cut ? { truncated: true as const } : {}),
        ...(message.isError ? { isError: true as const } : {}),
        ...(stored.outcome ? { outcome: stored.outcome as never } : {}),
      };
    }
  }
}
