/** Transcript items → the rows the transcript renders. Row objects are stable per entry, so rows memoize. */
import { MESSAGE_KIND, type ConversationSnapshot, type EntryRecord, type MessageData, type TranscriptItem } from "@top/client";

type Part = { type: string; text?: string; thinking?: string; name?: string };
type Message = { role?: string; content?: string | Part[]; timestamp?: number; stopReason?: string; errorMessage?: string };

export type Row =
  | { readonly kind: "earlier"; readonly key: string }
  | { readonly kind: "gap"; readonly key: string; readonly gap: Extract<TranscriptItem, { kind: "gap" }> }
  | { readonly kind: "user"; readonly key: string; readonly text: string; readonly at?: number; readonly state?: "sending" | "accepted" | "failed" | "queued" | "steer"; readonly requestId?: string; readonly error?: string }
  | { readonly kind: "assistant"; readonly key: string; readonly text: string; readonly thinking?: string; readonly tools: readonly string[]; readonly at?: number; readonly error?: string }
  | { readonly kind: "notice"; readonly key: string; readonly text: string }
  | { readonly kind: "live"; readonly key: "live" };

function textOf(message: Message | undefined): string {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  return (message.content ?? []).map((p) => (p.type === "text" ? (p.text ?? "") : "")).join("");
}

const entryRows = new WeakMap<EntryRecord, Row | null>();

function rowForEntry(entry: EntryRecord): Row | null {
  let row = entryRows.get(entry);
  if (row !== undefined) return row;
  const key = `e${entry.id}`;
  const message = entry.model?.at(-1) as Message | undefined;
  switch (entry.kind) {
    case MESSAGE_KIND: {
      const data = entry.data as MessageData;
      row = { kind: "user", key, text: data.text, at: message?.timestamp };
      break;
    }
    case "pi.user":
      row = { kind: "user", key, text: textOf(message), at: message?.timestamp };
      break;
    case "pi.assistant": {
      const parts = typeof message?.content === "string" ? [] : (message?.content ?? []);
      const thinking = parts.filter((p) => p.type === "thinking").map((p) => p.thinking ?? "").join("\n");
      row = {
        kind: "assistant",
        key,
        text: textOf(message),
        thinking: thinking || undefined,
        tools: parts.filter((p) => p.type === "toolCall").map((p) => p.name ?? "tool"),
        at: message?.timestamp,
        error: message?.stopReason === "error" || message?.stopReason === "aborted" ? (message.errorMessage ?? message.stopReason) : undefined,
      };
      break;
    }
    case "pi.reset":
      row = { kind: "notice", key, text: "Context reset" };
      break;
    case "pi.compaction":
      row = { kind: "notice", key, text: "Earlier messages summarized" };
      break;
    default:
      row = null; // pi.system, tool results etc.: not shown in the chat view
  }
  entryRows.set(entry, row);
  return row;
}

const itemRowsCache = new WeakMap<readonly TranscriptItem[], Row[]>();

/** Rows for the committed transcript; recomputed only when `items` changes (entries appended or loaded). */
export function committedRows(items: readonly TranscriptItem[]): Row[] {
  let rows = itemRowsCache.get(items);
  if (rows) return rows;
  rows = [];
  for (const item of items) {
    if (item.kind === "earlier") rows.push({ kind: "earlier", key: "earlier" });
    else if (item.kind === "gap") rows.push({ kind: "gap", key: `gap${item.after}`, gap: item });
    else {
      const row = rowForEntry(item.entry);
      if (row) rows.push(row);
    }
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

/** Rows after the transcript: the streaming answer, queued messages, and messages not acknowledged yet. */
export function tailRows(snapshot: ConversationSnapshot): Row[] {
  const rows: Row[] = [];
  if (snapshot.live?.run) rows.push({ kind: "live", key: "live" });
  for (const item of snapshot.inbox?.items ?? []) {
    if (item.mode === "write") continue;
    rows.push(
      stable(item, () => {
        const data = (item.entry as { kind?: string; data?: MessageData } | undefined)?.data;
        const text = data?.text ?? (typeof item.content === "string" ? item.content : "");
        return { kind: "user", key: `q${item.id}`, text, state: item.mode === "steer" ? "steer" : "queued" };
      }),
    );
  }
  for (const pending of snapshot.pending) {
    rows.push(
      stable(pending, () => ({
        kind: "user",
        key: `p${pending.requestId}`,
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

export function liveText(snapshot: ConversationSnapshot): string {
  return textOf(snapshot.live?.generation?.message as Message | undefined);
}
