import { AgentSpawn, Ask, BotMessageSent, CreatedBot, type Entry, type ToolCallView } from "@top/protocol";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { peerBody } from "./botMessages.ts";
import { textOf } from "./messages.ts";
import type { StoredEntry } from "./store.ts";
import { searchStep } from "./websearch.ts";

export { textOf };

const TOOL_PREVIEW_CHARS = 280;
const ARGS_SUMMARY_CHARS = 100;

export function summarize(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const text = Object.entries(args)
    .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join(", ")
    .replace(/\s+/g, " ");
  return text.length > ARGS_SUMMARY_CHARS ? `${text.slice(0, ARGS_SUMMARY_CHARS - 1)}…` : text;
}

const askOf = Schema.decodeUnknownOption(Schema.Struct({ ask: Ask }));
const agentOf = Schema.decodeUnknownOption(Schema.Struct({ agent: AgentSpawn }));
const botMessageOf = Schema.decodeUnknownOption(Schema.Struct({ botMessage: BotMessageSent }));
const createdBotOf = Schema.decodeUnknownOption(Schema.Struct({ createdBot: CreatedBot }));
const legacyTaskOf = Schema.decodeUnknownOption(Schema.Struct({ task: Schema.String }));
const legacyStartOf = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      started: Schema.Struct({ title: Schema.optional(Schema.String), harness: Schema.String, cwd: Schema.String, model: Schema.optional(Schema.String) }),
    }),
  ),
);

/** A start saved before receipts kept their own details still shows one, from its result. */
function legacyAgent(details: unknown, text: string): AgentSpawn | undefined {
  if (Option.isNone(legacyTaskOf(details))) return undefined;
  const started = Option.getOrUndefined(legacyStartOf(text))?.started;
  return started
    ? { ...(started.title ? { title: started.title } : {}), harness: started.harness, cwd: started.cwd, ...(started.model ? { model: started.model } : {}) }
    : undefined;
}

export function toWire(stored: StoredEntry, full = false): Entry | undefined {
  const base = { seq: stored.seq, bot: stored.bot, at: stored.at };
  switch (stored.kind) {
    case "system":
    case "compaction":
      return undefined;
    case "notice":
      return { ...base, kind: "notice", text: stored.message.text };
    case "files":
      return { ...base, kind: "files", files: stored.message.files };
    case "answer":
      return {
        ...base,
        kind: "answer",
        request: stored.message.request,
        answer: stored.message.answer,
        ...(stored.message.reply ? { reply: stored.message.reply } : {}),
      };
    case "user": {
      const { content, attachments, peer } = stored.message;
      const skill = typeof content === "string" ? undefined : content.flatMap((p) => (p.type === "text" && p.skill ? [p.skill] : []))[0];
      const said = textOf(typeof content === "string" ? content : content.filter((p) => !(p.type === "text" && (p.attachmentNote || p.skill))));
      return {
        ...base,
        kind: "user",
        // A bot's message shows as it was sent, without the line Top put above it for the model.
        text: peer && !peer.outcome ? peerBody(said) : said,
        ...(peer ? { peer } : {}),
        ...(attachments?.length ? { attachments } : {}),
        ...(skill ? { skill } : {}),
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
      const searches = message.webSearch?.searches.map((s) => searchStep(s.item, full)) ?? [];
      const citations = message.webSearch?.citations ?? [];
      return {
        ...base,
        kind: "assistant",
        text: textOf(message.content),
        ...(tools.length ? { tools } : {}),
        ...(searches.length ? { searches } : {}),
        ...(citations.length ? { citations } : {}),
        ...(thinking ? (full ? { thinking } : { hasThinking: true as const }) : {}),
        ...(failed ? { error: message.errorMessage || message.stopReason } : {}),
        ...(message.stopReason === "aborted" ? { stopped: true as const } : {}),
      };
    }
    case "tool": {
      const message = stored.message;
      const text = textOf(message.content);
      const cut = !full && text.length > TOOL_PREVIEW_CHARS;
      const ask = Option.getOrUndefined(askOf(message.details))?.ask;
      const agent = Option.getOrUndefined(agentOf(message.details))?.agent ?? legacyAgent(message.details, text);
      const botMessage = message.isError ? undefined : Option.getOrUndefined(botMessageOf(message.details))?.botMessage;
      const createdBot = message.isError ? undefined : Option.getOrUndefined(createdBotOf(message.details))?.createdBot;
      return {
        ...base,
        kind: "tool",
        toolCallId: stored.toolCallId ?? message.toolCallId,
        name: message.toolName,
        text: cut ? `${text.slice(0, TOOL_PREVIEW_CHARS - 1)}…` : text,
        ...(cut ? { truncated: true as const } : {}),
        ...(message.isError ? { isError: true as const } : {}),
        ...(stored.outcome ? { outcome: stored.outcome } : {}),
        ...(ask ? { ask } : {}),
        ...(agent ? { agent } : {}),
        ...(botMessage ? { botMessage } : {}),
        ...(createdBot ? { createdBot } : {}),
      };
    }
  }
}
