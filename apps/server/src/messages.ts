import type { AssistantMessage, ImageContent, SystemMessage, TextContent, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { AskOutcome, Attachment, Citation, FileChange, QuestionReply, SkillUse } from "@top/protocol";
import * as Schema from "effect/Schema";

export interface UserText extends TextContent {
  readonly attachmentNote?: true;
  readonly skill?: SkillUse;
}
export interface UserImage extends ImageContent {
  readonly attachment?: string;
}
export interface TopUserMessage extends UserMessage {
  content: string | (UserText | UserImage)[];
  readonly attachments?: readonly Attachment[];
}

export type SearchItem = { readonly type: "web_search_call"; readonly id: string; readonly status: string; readonly action?: unknown };
export type SearchRecord = { readonly item: SearchItem; readonly after?: string; readonly before?: string };
export type WebSearchRecord = { readonly searches: readonly SearchRecord[]; readonly citations: readonly Citation[] };

export interface TopAssistantMessage extends AssistantMessage {
  webSearch?: WebSearchRecord;
}

export type TranscriptMessage = SystemMessage | TopUserMessage | TopAssistantMessage | ToolResultMessage;

export type EntryBody = {
  readonly system: SystemMessage;
  readonly user: TopUserMessage;
  readonly assistant: TopAssistantMessage;
  readonly tool: ToolResultMessage;
  readonly notice: { readonly text: string };
  readonly files: { readonly files: readonly FileChange[] };
  readonly answer: typeof AnswerView.Type;
  readonly compaction: Compaction;
};

export type Compaction = {
  readonly summary: string;
  /** A handoff document from another runtime (handoff.ts), not the model's own summary. */
  readonly handoff?: true;
  readonly keptFrom: number;
  readonly tokensBefore: number;
  readonly usage?: unknown;
  readonly timestamp: number;
};

const Optional = Schema.optionalKey;

const Text = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
  attachmentNote: Optional(Schema.Literal(true)),
  skill: Optional(SkillUse),
});
const Image = Schema.Struct({ type: Schema.Literal("image"), mimeType: Schema.String, data: Schema.String, attachment: Optional(Schema.String) });
const Thinking = Schema.Struct({ type: Schema.Literal("thinking"), thinking: Schema.String });
const ToolCall = Schema.Struct({ type: Schema.Literal("toolCall"), id: Schema.String, name: Schema.String, arguments: Schema.Unknown });

export const SystemView = Schema.Struct({
  role: Schema.Literal("system"),
  content: Schema.Union([Schema.String, Schema.Array(Text)]),
  timestamp: Schema.Number,
});
export const UserView = Schema.Struct({
  role: Schema.Literal("user"),
  content: Schema.Union([Schema.String, Schema.Array(Schema.Union([Text, Image]))]),
  attachments: Optional(Schema.Array(Attachment)),
  timestamp: Schema.Number,
});
const SearchItemView = Schema.Struct({ type: Schema.Literal("web_search_call"), id: Schema.String, status: Schema.String, action: Optional(Schema.Unknown) });
const WebSearchView = Schema.Struct({
  searches: Schema.Array(Schema.Struct({ item: SearchItemView, after: Optional(Schema.String), before: Optional(Schema.String) })),
  citations: Schema.Array(Citation),
});
export const AssistantView = Schema.Struct({
  role: Schema.Literal("assistant"),
  content: Schema.Union([Schema.String, Schema.Array(Schema.Union([Text, Thinking, ToolCall]))]),
  stopReason: Schema.String,
  errorMessage: Optional(Schema.String),
  webSearch: Optional(WebSearchView),
  timestamp: Schema.Number,
});
export const ToolResultView = Schema.Struct({
  role: Schema.Literal("toolResult"),
  toolCallId: Schema.String,
  toolName: Schema.String,
  content: Schema.Array(Schema.Union([Text, Image])),
  isError: Schema.Boolean,
  details: Schema.optionalKey(Schema.Unknown),
  timestamp: Schema.Number,
});
export const NoticeView = Schema.Struct({ text: Schema.String });
export const CompactionView = Schema.Struct({
  summary: Schema.String,
  handoff: Optional(Schema.Literal(true)),
  keptFrom: Schema.Number,
  tokensBefore: Schema.Number,
  usage: Optional(Schema.Unknown),
  timestamp: Schema.Number,
});
export const FilesView = Schema.Struct({ files: Schema.Array(FileChange) });
export const AnswerView = Schema.Struct({ request: Schema.Int, answer: AskOutcome, reply: Optional(QuestionReply) });

export type AssistantView = typeof AssistantView.Type;
export type Content = AssistantView["content"] | typeof UserView.Type.content | typeof ToolResultView.Type.content;

export function textOf(content: Content | undefined): string {
  if (typeof content === "string") return content;
  return (content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");
}

const modelViews = { system: SystemView, user: UserView, assistant: AssistantView, tool: ToolResultView } as const;

export function transcriptMessage(kind: keyof typeof modelViews, message: unknown): TranscriptMessage {
  Schema.asserts(modelViews[kind], message);
  return message as TranscriptMessage;
}
