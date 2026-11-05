/** Transcript items → the rows the transcript renders. Row objects are stable per entry, so rows memoize. */
import type { BotSummary, ConversationSnapshot, Entry, Gap, PendingMessage, QueuedMessage, ToolCallView, TranscriptItem } from "@top/client";

export type ToolEntry = Extract<Entry, { kind: "tool" }>;

export type Row =
  | { readonly kind: "earlier"; readonly key: string }
  | { readonly kind: "gap"; readonly key: string; readonly gap: Gap }
  | { readonly kind: "user"; readonly key: string; readonly text: string; readonly at?: number; readonly state?: "sending" | "accepted" | "failed" | "queued" | "steer"; readonly requestId?: string; readonly error?: string }
  | {
      readonly kind: "assistant";
      readonly key: string;
      readonly seq: number;
      readonly text: string;
      readonly tools: readonly ToolCallView[];
      readonly hasThinking: boolean;
      readonly at: number;
      readonly error?: string;
    }
  | { readonly kind: "tool"; readonly key: string; readonly entry: ToolEntry }
  | { readonly kind: "notice"; readonly key: string; readonly text: string }
  | { readonly kind: "working"; readonly key: "working" };

const entryRows = new WeakMap<Entry, Row>();

function rowForEntry(entry: Entry): Row {
  let row = entryRows.get(entry);
  if (row) return row;
  const key = `e${entry.seq}`;
  switch (entry.kind) {
    case "user":
      row = { kind: "user", key, text: entry.text, at: entry.at };
      break;
    case "assistant":
      row = { kind: "assistant", key, seq: entry.seq, text: entry.text, tools: entry.tools ?? [], hasThinking: !!entry.hasThinking, at: entry.at, error: entry.stopped ? "Stopped" : entry.error };
      break;
    case "tool":
      row = { kind: "tool", key, entry };
      break;
    case "notice":
      row = { kind: "notice", key, text: entry.text };
      break;
  }
  entryRows.set(entry, row);
  return row;
}

const itemRowsCache = new WeakMap<readonly TranscriptItem[], Row[]>();

/** Rows for the transcript; recomputed only when `items` changes (entries arrived or loaded). */
export function committedRows(items: readonly TranscriptItem[]): Row[] {
  let rows = itemRowsCache.get(items);
  if (rows) return rows;
  rows = [];
  for (const item of items) {
    if (item.kind === "earlier") rows.push({ kind: "earlier", key: "earlier" });
    else if (item.kind === "gap") rows.push({ kind: "gap", key: `gap${item.gap.after}`, gap: item.gap });
    else rows.push(rowForEntry(item.entry));
  }
  itemRowsCache.set(items, rows);
  return rows;
}

const tailCache = new WeakMap<object, Row>();
function stable<T extends object>(source: T, make: () => Row): Row {
  let row = tailCache.get(source);
  if (!row) tailCache.set(source, (row = make()));
  return row;
}

const WORKING: Row = { kind: "working", key: "working" };

export const isWorking = (status: BotSummary["status"] | undefined) => status === "thinking" || status === "tool" || status === "retrying";

/** Rows after the transcript: what the bot is doing, queued messages, and messages not acknowledged yet. */
export function tailRows(snapshot: ConversationSnapshot, working: boolean): Row[] {
  const rows: Row[] = [];
  if (working) rows.push(WORKING);
  for (const item of snapshot.inbox) {
    rows.push(stable<QueuedMessage>(item, () => ({ kind: "user", key: `m${item.requestId}`, text: item.text, at: item.at, state: item.mode === "steer" ? "steer" : "queued" })));
  }
  for (const pending of snapshot.pending) {
    rows.push(
      stable<PendingMessage>(pending, () => ({
        kind: "user",
        key: `m${pending.requestId}`,
        text: pending.text,
        at: pending.createdAt,
        state: pending.state,
        requestId: pending.requestId,
        error: pending.error,
      })),
    );
  }
  return rows;
}
