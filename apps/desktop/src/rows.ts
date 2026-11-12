/** Transcript items → the rows the transcript renders. Row objects are stable per entry, so rows memoize. */
import type {
  Attachment,
  BotSummary,
  ConversationSnapshot,
  Entry,
  FileChange,
  Gap,
  PendingMessage,
  QueuedMessage,
  ToolCallView,
  TranscriptItem,
} from "@top/client";

export type ToolEntry = Extract<Entry, { kind: "tool" }>;

export type Row =
  | { readonly kind: "earlier"; readonly key: string }
  | { readonly kind: "gap"; readonly key: string; readonly gap: Gap }
  | {
      readonly kind: "user";
      readonly key: string;
      readonly text: string;
      readonly attachments?: readonly Attachment[];
      readonly at?: number;
      readonly state?: "sending" | "accepted" | "failed" | "queued" | "steer";
      readonly requestId?: string;
      readonly error?: string;
    }
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
  /** Files in the bot's folder changed. */
  | { readonly kind: "files"; readonly key: string; readonly seq: number; readonly files: readonly FileChange[] }
  | { readonly kind: "working"; readonly key: "working" };

const entryRows = new WeakMap<Entry, Row>();

/**
 * A background job's result shows no row: the bot's reply that follows says what came of it.
 * (The bot still gets the message; only the transcript leaves it out.)
 */
const hidden = (source: string | undefined) => source === "job";

/**
 * Any other message from Top rather than the user (a wake-up) shows as one line:
 * its first, "[Wake-up] check the deploy" → "Wake-up: check the deploy".
 */
export function eventLine(text: string): string {
  const first = text.split("\n", 1)[0]!.replace(/^\[([^\]]+)\]\s*/, "$1: ");
  return first.length > 160 ? `${first.slice(0, 159)}…` : first;
}

function rowForEntry(entry: Entry): Row {
  let row = entryRows.get(entry);
  if (row) return row;
  const key = `e${entry.seq}`;
  switch (entry.kind) {
    case "user":
      row = entry.source
        ? { kind: "notice", key, text: eventLine(entry.text) }
        : { kind: "user", key, text: entry.text, at: entry.at, ...(entry.attachments ? { attachments: entry.attachments } : {}) };
      break;
    case "assistant":
      row = {
        kind: "assistant",
        key,
        seq: entry.seq,
        text: entry.text,
        tools: entry.tools ?? [],
        hasThinking: !!entry.hasThinking,
        at: entry.at,
        error: entry.stopped ? "Stopped" : entry.error,
      };
      break;
    case "tool":
      row = { kind: "tool", key, entry };
      break;
    case "notice":
      row = { kind: "notice", key, text: entry.text };
      break;
    case "files":
      row = { kind: "files", key, seq: entry.seq, files: entry.files };
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
    else if (!(item.entry.kind === "user" && hidden(item.entry.source))) rows.push(rowForEntry(item.entry));
  }
  itemRowsCache.set(items, rows);
  return rows;
}

const tailCache = new WeakMap<object, Row>();
function stable<T extends object>(source: T, make: () => Row): Row {
  let row = tailCache.get(source);
  if (!row) {
    row = make();
    tailCache.set(source, row);
  }
  return row;
}

const WORKING: Row = { kind: "working", key: "working" };

export const isWorking = (status: BotSummary["status"] | undefined) => status === "thinking" || status === "tool" || status === "retrying";

/** Rows after the transcript: what the bot is doing, queued messages, and messages not acknowledged yet. */
export function tailRows(snapshot: ConversationSnapshot, working: boolean): Row[] {
  const rows: Row[] = [];
  if (working) rows.push(WORKING);
  for (const item of snapshot.inbox) {
    if (hidden(item.source)) continue;
    rows.push(
      stable<QueuedMessage>(item, () =>
        item.source
          ? { kind: "notice", key: `m${item.requestId}`, text: eventLine(item.text) }
          : {
              kind: "user",
              key: `m${item.requestId}`,
              text: item.text,
              ...(item.attachments ? { attachments: item.attachments } : {}),
              at: item.at,
              state: item.mode === "steer" ? "steer" : "queued",
            },
      ),
    );
  }
  for (const pending of snapshot.pending) {
    rows.push(
      stable<PendingMessage>(pending, () => ({
        kind: "user",
        key: `m${pending.requestId}`,
        text: pending.text,
        ...(pending.attachments ? { attachments: pending.attachments } : {}),
        at: pending.createdAt,
        state: pending.state,
        requestId: pending.requestId,
        error: pending.error,
      })),
    );
  }
  return rows;
}

/** A run of consecutive tool steps, shown as one collapsed line. */
export type ToolGroupRow = { readonly kind: "toolgroup"; readonly key: string; readonly entries: readonly ToolEntry[]; readonly at: number };
export type DisplayRow = Exclude<Row, { kind: "tool" }> | ToolGroupRow;
export type FilesRow = Extract<Row, { kind: "files" }>;

/** Who a row speaks for, in the styles that group messages by author. */
export function author(row: DisplayRow): "user" | "bot" | undefined {
  if (row.kind === "user") return "user";
  if (row.kind === "assistant" || row.kind === "toolgroup" || row.kind === "working") return "bot";
  return undefined;
}

export function rowTime(row: DisplayRow | undefined): number | undefined {
  if (!row) return undefined;
  if (row.kind === "user" || row.kind === "assistant" || row.kind === "toolgroup") return row.at;
  return undefined;
}

const groupCache = new Map<string, ToolGroupRow>();
const filesCache = new Map<string, { parts: readonly FilesRow[]; row: FilesRow }>();

/** What a file went through, as one change: made then edited is "added", made then removed is nothing. */
const CHANGE: Record<string, Record<string, FileChange["change"] | null>> = {
  added: { added: "added", changed: "added", removed: null },
  changed: { added: "changed", changed: "changed", removed: "removed" },
  removed: { added: "changed", changed: "changed", removed: "removed" },
};

/** Several files rows as one, keeping its identity while its parts are the same. */
function mergeFiles(parts: readonly FilesRow[]): FilesRow {
  if (parts.length === 1) return parts[0]!;
  const key = parts[0]!.key;
  const prev = filesCache.get(key);
  if (prev && prev.parts.length === parts.length && prev.parts.every((p, i) => p === parts[i])) return prev.row;
  const changes = new Map<string, FileChange["change"]>();
  for (const part of parts) {
    for (const { path, change } of part.files) {
      const before = changes.get(path);
      const next = before ? CHANGE[before]![change]! : change;
      if (next) changes.set(path, next);
      else changes.delete(path);
    }
  }
  const files = [...changes].map(([path, change]) => ({ path, change }));
  const row: FilesRow = { kind: "files", key, seq: parts.at(-1)!.seq, files };
  filesCache.set(key, { parts, row });
  return row;
}

/**
 * Rows as the transcript shows them: reasoning-only and tool-call-only answers disappear (their
 * tool steps follow), and consecutive tool steps fold into one row. Group rows keep their identity
 * while their steps are unchanged, so memoized rows don't re-render.
 *
 * File changes wait for the end of the bot's turn (or its "working" row) and show there as one line,
 * so a turn that wrote a report says so once, under the answer, instead of splitting its steps.
 *
 * With `showTools` off, tool steps are left out altogether.
 */
export function displayRows(rows: readonly Row[], showTools = true): DisplayRow[] {
  const out: DisplayRow[] = [];
  let run: ToolEntry[] | null = null;
  let files: FilesRow[] = [];
  const flushFiles = () => {
    if (!files.length) return;
    const row = mergeFiles(files);
    if (row.files.length) out.push(row);
    files = [];
  };
  const flush = () => {
    if (!run) return;
    const key = `g${run[0]!.seq}`;
    const prev = groupCache.get(key);
    const entries = run;
    const same = prev && prev.entries.length === entries.length && prev.entries.every((e, i) => e === entries[i]);
    const group: ToolGroupRow = same ? prev : { kind: "toolgroup", key, entries, at: entries[entries.length - 1]!.at };
    if (!same) groupCache.set(key, group);
    out.push(group);
    run = null;
  };
  for (const row of rows) {
    if (row.kind === "files") {
      files.push(row);
      continue;
    }
    if (row.kind === "tool") {
      if (!showTools) continue;
      run ??= [];
      run.push(row.entry);
      continue;
    }
    // A tool-call-only answer sits between tool steps; skipping it keeps the run together.
    if (row.kind === "assistant" && !row.text && !row.error) continue;
    flush();
    if (row.kind === "working" || author(row) !== "bot") flushFiles();
    out.push(row);
  }
  flush();
  flushFiles();
  if (groupCache.size > 5_000) groupCache.clear();
  if (filesCache.size > 2_000) filesCache.clear();
  return out;
}
