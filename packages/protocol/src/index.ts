/**
 * Top's wire protocol: JSON frames over one WebSocket between the Top daemon and its clients.
 *
 * The daemon owns the Pi Durable Harness. Clients never assemble state from events: they hold the
 * conversation view the daemon sent, apply Chord ops to it, and render the newest value.
 */

/** A Chord wire op, as `encoder().encode()` emits it. Kept opaque here so this package has no dependencies. */
export type WireOp = readonly unknown[];

/** Pi Durable IDs cross the wire as they are (entry and conversation IDs are numbers today). */
export type WireId = string | number;

export type BotStatus = "idle" | "thinking" | "streaming" | "tool" | "failed";

export type BotSummary = {
  /** The bot's conversation ID. */
  readonly id: WireId;
  readonly name: string;
  readonly status: BotStatus;
  /** The last line of what the bot said or is saying, for the sidebar. */
  readonly preview: string;
  /** Messages queued behind the running turn. */
  readonly queued: number;
  readonly updatedAt: number;
};

export type WatchWindow = { readonly from?: WireId; readonly min?: number; readonly max?: number };

/** `EntryQuery` without its conversation, as `Conversation.entries()` takes it. */
export type EntryQueryWire = {
  readonly minEntryId?: WireId;
  readonly maxEntryId?: WireId;
  readonly order?: "ascending" | "descending";
};

export type WhenBusy = "steer" | "followUp" | "reject";

// ── client → daemon ──────────────────────────────────────────────────────────────

export type ClientFrame =
  | { readonly t: "hello"; readonly clientId: string; readonly protocol: typeof PROTOCOL_VERSION }
  | { readonly t: "watch"; readonly sub: number; readonly conversationId: WireId; readonly window?: WatchWindow }
  | { readonly t: "unwatch"; readonly sub: number }
  | {
      readonly t: "entries";
      readonly req: number;
      readonly conversationId: WireId;
      readonly query: EntryQueryWire;
      readonly limit: number;
    }
  | {
      readonly t: "submit";
      readonly req: number;
      readonly conversationId: WireId;
      /** Idempotency key: a resend after a drop is applied once. */
      readonly requestId: string;
      readonly content: string;
      readonly whenBusy: WhenBusy;
      readonly clientId: string;
    }
  | { readonly t: "abort"; readonly req: number; readonly conversationId: WireId }
  | { readonly t: "ping"; readonly at: number };

// ── daemon → client ──────────────────────────────────────────────────────────────

export type ServerFrame =
  | { readonly t: "welcome"; readonly serverId: string; readonly protocol: typeof PROTOCOL_VERSION }
  | { readonly t: "bots"; readonly bots: readonly BotSummary[] }
  /** First value of a watch. Later changes arrive as `ops` against it, encoded per subscription. */
  | { readonly t: "view"; readonly sub: number; readonly value: unknown }
  | { readonly t: "ops"; readonly sub: number; readonly ops: readonly WireOp[] }
  | { readonly t: "end"; readonly sub: number; readonly reason: string }
  | { readonly t: "result"; readonly req: number; readonly ok: true; readonly value: unknown }
  | { readonly t: "result"; readonly req: number; readonly ok: false; readonly error: string }
  | { readonly t: "pong"; readonly at: number };

export const PROTOCOL_VERSION = 1;

/**
 * Messages a person sends are placed as this entry kind rather than `pi.user`, carrying the
 * client's `requestId`, so a client can retire its optimistic copy exactly when the real one lands.
 * The model still sees `text` as a plain user message.
 */
export const MESSAGE_KIND = "top.message";
export type MessageData = { readonly requestId: string; readonly text: string; readonly clientId: string };

export const DEFAULT_PORT = 7357;
