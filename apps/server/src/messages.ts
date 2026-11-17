/**
 * The messages Top keeps in `entries.message` (JSON), by entry kind.
 *
 * Model messages are pi-ai's, plus what Top adds to a user message: the attachments it came with, a
 * marked note telling the bot where they are saved, images held by attachment id (attachments.ts
 * reads their bytes in for each request), and the SKILL.md of a skill the message asked for with
 * `/<name>`, marked with the skill (see skills.ts).
 *
 * Every entry read back is checked against a Schema of what Top itself reads (the `*View` schemas).
 * They're lenient where pi's own types are strict, so transcripts written by earlier versions still
 * load: an answer's usage, provider metadata and the like are pi's to read, and pass through as saved.
 */
import type { AssistantMessage, ImageContent, SystemMessage, TextContent, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { Attachment, FileChange, PermissionAnswer, SkillUse } from "@top/protocol";
import * as Schema from "effect/Schema";

// ── types ────────────────────────────────────────────────────────────────────────

/**
 * Text in a user message. `attachmentNote` marks the line telling the bot where attachments are saved;
 * `skill`, the instructions of the skill the message asked for. Neither is what the user wrote.
 */
export interface UserText extends TextContent {
  readonly attachmentNote?: true;
  readonly skill?: SkillUse;
}
/** An image in a user message: stored with its attachment's id and empty `data`, which each request fills in. */
export interface UserImage extends ImageContent {
  readonly attachment?: string;
}
export interface TopUserMessage extends UserMessage {
  content: string | (UserText | UserImage)[];
  readonly attachments?: readonly Attachment[];
}

/** A message in a bot's transcript, as the model sees it. */
export type TranscriptMessage = SystemMessage | TopUserMessage | AssistantMessage | ToolResultMessage;

/** What each kind of entry stores. */
export type EntryBody = {
  readonly system: SystemMessage;
  readonly user: TopUserMessage;
  readonly assistant: AssistantMessage;
  readonly tool: ToolResultMessage;
  readonly notice: { readonly text: string };
  readonly files: { readonly files: readonly FileChange[] };
  /** What came of a permission request (see permissions.ts). */
  readonly permission: { readonly request: number; readonly answer: PermissionAnswer };
  readonly compaction: Compaction;
};

/** The transcript before `keptFrom` was summarised (see compaction.ts). Clients never see it. */
export type Compaction = {
  readonly summary: string;
  /** The seq of the first entry kept word for word; past the last one when none was kept. */
  readonly keptFrom: number;
  /** The transcript's size before, as estimated. */
  readonly tokensBefore: number;
  /** What the summary request cost, as the provider counted it. */
  readonly usage?: unknown;
  readonly timestamp: number;
};

// ── what Top reads ───────────────────────────────────────────────────────────────

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
/** Plain string content: answers saved by earlier versions. */
export const AssistantView = Schema.Struct({
  role: Schema.Literal("assistant"),
  content: Schema.Union([Schema.String, Schema.Array(Schema.Union([Text, Thinking, ToolCall]))]),
  stopReason: Schema.String,
  errorMessage: Optional(Schema.String),
  timestamp: Schema.Number,
});
export const ToolResultView = Schema.Struct({
  role: Schema.Literal("toolResult"),
  toolCallId: Schema.String,
  toolName: Schema.String,
  content: Schema.Array(Schema.Union([Text, Image])),
  isError: Schema.Boolean,
  /** What the tool told clients besides its text (the request a permission call made, see wire.ts). */
  details: Schema.optionalKey(Schema.Unknown),
  timestamp: Schema.Number,
});
export const NoticeView = Schema.Struct({ text: Schema.String });
export const CompactionView = Schema.Struct({
  summary: Schema.String,
  keptFrom: Schema.Number,
  tokensBefore: Schema.Number,
  usage: Optional(Schema.Unknown),
  timestamp: Schema.Number,
});
export const FilesView = Schema.Struct({ files: Schema.Array(FileChange) });
export const PermissionView = Schema.Struct({ request: Schema.Int, answer: PermissionAnswer });

export type AssistantView = typeof AssistantView.Type;
export type Content = AssistantView["content"] | typeof UserView.Type.content | typeof ToolResultView.Type.content;

/** The text parts of some content, joined. */
export function textOf(content: Content | undefined): string {
  if (typeof content === "string") return content;
  return (content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");
}

const modelViews = { system: SystemView, user: UserView, assistant: AssistantView, tool: ToolResultView } as const;

/**
 * A transcript message read back from storage. Checked for what Top reads; the rest of it is pi's and
 * is handed to pi as it was saved, so this is where the stored JSON becomes pi's type.
 */
export function transcriptMessage(kind: keyof typeof modelViews, message: unknown): TranscriptMessage {
  Schema.asserts(modelViews[kind], message);
  return message as TranscriptMessage;
}
