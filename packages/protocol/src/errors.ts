/**
 * The daemon's refusals, shared by both ends. Each says what went wrong in words for the user. On the
 * wire a failed request carries `"<Tag>: <message>"` (see the `result` frame).
 */
import * as Schema from "effect/Schema";

/** A bot couldn't be made or changed: its name is taken, too long, missing, … */
export class BotError extends Schema.TaggedError<BotError>()("BotError", { message: Schema.String }) {}

/** The bot is working and the message asked not to wait (`whenBusy: "reject"`). */
export class BusyError extends Schema.TaggedError<BusyError>()("BusyError", { message: Schema.String }) {}

/** A message's attachments are missing, too many, or the message has nothing in it. */
export class AttachmentError extends Schema.TaggedError<AttachmentError>()("AttachmentError", { message: Schema.String }) {}

/** An MCP server couldn't be saved, signed in to, or found. */
export class McpServerError extends Schema.TaggedError<McpServerError>()("McpServerError", { message: Schema.String }) {}

/** A permission answer came too late: the request was answered already, or isn't waiting anymore. */
export class PermissionError extends Schema.TaggedError<PermissionError>()("PermissionError", { message: Schema.String }) {}

/** The request named a bot this daemon doesn't have. */
export class UnknownBotError extends Schema.TaggedError<UnknownBotError>()("UnknownBotError", { bot: Schema.Int }) {
  override get message(): string {
    return `Unknown bot ${this.bot}`;
  }
}

/** A request named an entry that isn't there (or isn't that bot's). */
export class UnknownEntryError extends Schema.TaggedError<UnknownEntryError>()("UnknownEntryError", { seq: Schema.Int }) {
  override get message(): string {
    return `No entry ${this.seq}`;
  }
}

/** Every refusal a request can get. */
export type DaemonRefusal = BotError | BusyError | AttachmentError | McpServerError | PermissionError | UnknownBotError | UnknownEntryError;
