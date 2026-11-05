/**
 * Top's wire protocol: JSON frames over one WebSocket (compressed with permessage-deflate) between
 * the Top daemon and its clients.
 *
 * Nothing streams. A bot's transcript is a list of finished, immutable entries, each with a sequence
 * number from one counter shared by all bots. A client says which entries it already has (`after`),
 * gets only the ones it is missing, then each new entry once. The sidebar gets one small summary per
 * bot that changed.
 */

export const PROTOCOL_VERSION = 2;
export const DEFAULT_PORT = 7357;

export type BotId = number;
/** Global, strictly increasing entry number. Entries of one bot are increasing but not contiguous. */
export type Seq = number;

export type BotStatus =
  /** Nothing running. */
  | "idle"
  /** Waiting on the model. */
  | "thinking"
  /** Running a tool (`tool` names it). */
  | "tool"
  /** The model request failed; retrying after a backoff. */
  | "retrying"
  /** The last run ended in an error it could not recover from. */
  | "failed";

export type BotSummary = {
  readonly id: BotId;
  readonly name: string;
  readonly status: BotStatus;
  /** The running tool's name while `status` is `tool`. */
  readonly tool?: string;
  /** When the current status began (ms since epoch), for an elapsed timer. */
  readonly since: number;
  /** The failure or retry reason, when there is one. */
  readonly error?: string;
  /** The last line of the bot's latest answer, for the sidebar. */
  readonly preview: string;
  /** Messages waiting behind the running task. */
  readonly queued: number;
  /** Newest entry of this bot, so a client can show "unread" without loading it. */
  readonly lastSeq: Seq;
};

export type ToolCallView = {
  readonly id: string;
  readonly name: string;
  /** The arguments, shortened to one line. */
  readonly summary: string;
};

/**
 * What happened to a tool call that was cut off by a daemon restart:
 * - `interrupted`: it may or may not have taken effect, and was not run again.
 * - `not_run`: the daemon stopped before the tool started.
 * - `recovered`: the tool checked its own outcome after the restart.
 * - `replayed`: the tool is safe to repeat, so it ran again.
 * - `stopped`: it kept crashing the daemon, so the task was ended.
 */
export type ToolOutcome = "interrupted" | "not_run" | "recovered" | "replayed" | "stopped";

type EntryBase = { readonly seq: Seq; readonly bot: BotId; readonly at: number };

export type Entry =
  | (EntryBase & { readonly kind: "user"; readonly text: string; readonly requestId?: string })
  | (EntryBase & {
      readonly kind: "assistant";
      readonly text: string;
      readonly tools?: readonly ToolCallView[];
      /** Thinking text exists; fetch it with `detail`. */
      readonly hasThinking?: true;
      /** Full thinking text, only in a `detail` answer. */
      readonly thinking?: string;
      readonly error?: string;
      readonly stopped?: true;
    })
  | (EntryBase & {
      readonly kind: "tool";
      readonly toolCallId: string;
      readonly name: string;
      /** The result text, shortened unless this came from `detail`. */
      readonly text: string;
      readonly truncated?: true;
      readonly isError?: true;
      readonly outcome?: ToolOutcome;
    })
  | (EntryBase & { readonly kind: "notice"; readonly text: string });

export type WhenBusy = "steer" | "followUp" | "reject";

export type QueuedMessage = {
  readonly requestId: string;
  readonly text: string;
  readonly mode: "steer" | "followUp";
  readonly at: number;
};

/** Entries strictly between `after` and `before` exist on the daemon but were not sent. */
export type Gap = { readonly after: Seq; readonly before: Seq };

// ── client → daemon ──────────────────────────────────────────────────────────────

export type ClientFrame =
  | { readonly t: "hello"; readonly clientId: string; readonly protocol: typeof PROTOCOL_VERSION }
  /** Follow a bot. `after`: the newest entry the client holds; omit it to get the newest `limit`. */
  | { readonly t: "watch"; readonly bot: BotId; readonly after?: Seq; readonly limit?: number }
  | { readonly t: "unwatch"; readonly bot: BotId }
  /** Entries older than `before` (and newer than `after`, if given), newest first up to `limit`. */
  | { readonly t: "history"; readonly req: number; readonly bot: BotId; readonly before: Seq; readonly after?: Seq; readonly limit: number }
  /** One entry in full: untruncated tool output, thinking, tool arguments. */
  | { readonly t: "detail"; readonly req: number; readonly bot: BotId; readonly seq: Seq }
  | {
      readonly t: "submit";
      readonly req: number;
      readonly bot: BotId;
      /** Idempotency key: a resend after a drop is applied once. */
      readonly requestId: string;
      readonly text: string;
      readonly whenBusy: WhenBusy;
      readonly clientId: string;
    }
  | { readonly t: "abort"; readonly req: number; readonly bot: BotId }
  | { readonly t: "ping"; readonly at: number };

export type HistoryResult = { readonly entries: readonly Entry[]; /** More entries remain in the asked range. */ readonly more: boolean };
export type SubmitResult = { readonly duplicate: boolean };

// ── daemon → client ──────────────────────────────────────────────────────────────

export type ServerFrame =
  | { readonly t: "welcome"; readonly serverId: string; readonly protocol: typeof PROTOCOL_VERSION }
  /** Every bot, once per connection. */
  | { readonly t: "bots"; readonly bots: readonly BotSummary[] }
  /** One bot's summary changed. */
  | { readonly t: "bot"; readonly bot: BotSummary }
  /**
   * The answer to `watch`: the entries the client is missing (ascending). When more were missing than
   * fit, the newest ones and a `gap`. `earlier`: older entries exist before the first one sent (only
   * when the client sent no `after`).
   */
  | { readonly t: "sync"; readonly bot: BotId; readonly entries: readonly Entry[]; readonly gap?: Gap; readonly earlier?: boolean; readonly inbox: readonly QueuedMessage[] }
  /** A new entry of a watched bot. */
  | { readonly t: "entry"; readonly entry: Entry }
  /** A watched bot's queue changed. */
  | { readonly t: "inbox"; readonly bot: BotId; readonly items: readonly QueuedMessage[] }
  | { readonly t: "result"; readonly req: number; readonly ok: true; readonly value: unknown }
  | { readonly t: "result"; readonly req: number; readonly ok: false; readonly error: string }
  | { readonly t: "pong"; readonly at: number };
