import * as Schema from "effect/Schema";

export class BotError extends Schema.TaggedError<BotError>()("BotError", { message: Schema.String }) {}

export class BusyError extends Schema.TaggedError<BusyError>()("BusyError", { message: Schema.String }) {}

export class AttachmentError extends Schema.TaggedError<AttachmentError>()("AttachmentError", { message: Schema.String }) {}

export class McpServerError extends Schema.TaggedError<McpServerError>()("McpServerError", { message: Schema.String }) {}

export class SkillError extends Schema.TaggedError<SkillError>()("SkillError", { message: Schema.String }) {}

export class PermissionError extends Schema.TaggedError<PermissionError>()("PermissionError", { message: Schema.String }) {}

export class UnknownBotError extends Schema.TaggedError<UnknownBotError>()("UnknownBotError", { bot: Schema.Int }) {
  override get message(): string {
    return `Unknown bot ${this.bot}`;
  }
}

export class UnknownEntryError extends Schema.TaggedError<UnknownEntryError>()("UnknownEntryError", { seq: Schema.Int }) {
  override get message(): string {
    return `No entry ${this.seq}`;
  }
}

export type DaemonRefusal = BotError | BusyError | AttachmentError | McpServerError | PermissionError | SkillError | UnknownBotError | UnknownEntryError;
