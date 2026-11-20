import type {
  Ask,
  AskOutcome,
  Attachment,
  BotSummary,
  Citation,
  ConversationSnapshot,
  Entry,
  FileChange,
  Gap,
  PendingMessage,
  QuestionReply,
  QueuedMessage,
  SkillUse,
  TaskView,
  ToolCallView,
  TranscriptItem,
  WebSearchStep,
} from "@top/client";

export type ToolEntry = Extract<Entry, { kind: "tool" }>;
type AnswerEntry = Extract<Entry, { kind: "answer" }>;

export type Row =
  | { readonly kind: "earlier"; readonly key: string }
  | { readonly kind: "gap"; readonly key: string; readonly gap: Gap }
  | {
      readonly kind: "user";
      readonly key: string;
      readonly text: string;
      readonly attachments?: readonly Attachment[];
      readonly skill?: SkillUse;
      readonly at?: number;
      readonly state?: "sending" | "accepted" | "failed" | "queued" | "steer";
      readonly requestId?: string;
      readonly error?: string | undefined;
    }
  | {
      readonly kind: "assistant";
      readonly key: string;
      readonly seq: number;
      readonly text: string;
      readonly tools: readonly ToolCallView[];
      readonly searches: readonly WebSearchStep[];
      readonly citations: readonly Citation[];
      readonly hasThinking: boolean;
      readonly at: number;
      readonly error?: string | undefined;
    }
  | { readonly kind: "tool"; readonly key: string; readonly entry: ToolEntry }
  | { readonly kind: "notice"; readonly key: string; readonly text: string }
  | { readonly kind: "wake"; readonly key: string }
  | {
      readonly kind: "ask";
      readonly key: string;
      readonly bot: number;
      readonly ask: Ask;
      readonly answer?: AskOutcome;
      readonly reply?: QuestionReply;
    }
  | { readonly kind: "task"; readonly key: string; readonly bot: number; readonly task: string; readonly title?: string }
  | { readonly kind: "files"; readonly key: string; readonly seq: number; readonly files: readonly FileChange[] }
  | { readonly kind: "working"; readonly key: "working" };

const entryRows = new WeakMap<Entry, Row>();
const NONE: readonly never[] = [];

const hidden = (source: string | undefined) => source === "job" || source === "answer" || source === "task";

function rowForEntry(entry: Exclude<Entry, AnswerEntry>): Row {
  let row = entryRows.get(entry);
  if (row) return row;
  const key = `e${entry.seq}`;
  switch (entry.kind) {
    case "user":
      row = entry.source
        ? { kind: "wake", key }
        : {
            kind: "user",
            key,
            text: entry.text,
            at: entry.at,
            ...(entry.attachments ? { attachments: entry.attachments } : {}),
            ...(entry.skill ? { skill: entry.skill } : {}),
          };
      break;
    case "assistant":
      row = {
        kind: "assistant",
        key,
        seq: entry.seq,
        text: entry.text,
        tools: entry.tools ?? [],
        searches: entry.searches ?? NONE,
        citations: entry.citations ?? NONE,
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

type AskRow = Extract<Row, { kind: "ask" }>;
const askRows = new WeakMap<ToolEntry, AskRow>();

function askRow(entry: ToolEntry, ask: Ask, settled: AnswerEntry | undefined): AskRow {
  const prev = askRows.get(entry);
  if (prev && prev.answer === settled?.answer && prev.reply === settled?.reply) return prev;
  const row: AskRow = {
    kind: "ask",
    key: `e${entry.seq}`,
    bot: entry.bot,
    ask,
    ...(settled ? { answer: settled.answer } : {}),
    ...(settled?.reply ? { reply: settled.reply } : {}),
  };
  askRows.set(entry, row);
  return row;
}

type TaskRow = Extract<Row, { kind: "task" }>;
const taskRows = new WeakMap<ToolEntry, TaskRow>();

function taskTitle(text: string): string | undefined {
  const match = /"title":"((?:[^"\\]|\\.)*)"/.exec(text);
  if (!match) return undefined;
  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return undefined;
  }
}

function taskRow(entry: ToolEntry, task: string): TaskRow {
  const prev = taskRows.get(entry);
  if (prev) return prev;
  const title = taskTitle(entry.text);
  const row: TaskRow = { kind: "task", key: `e${entry.seq}`, bot: entry.bot, task, ...(title ? { title } : {}) };
  taskRows.set(entry, row);
  return row;
}

export function committedRows(items: readonly TranscriptItem[]): Row[] {
  let rows = itemRowsCache.get(items);
  if (rows) return rows;
  rows = [];
  const settled = new Map<number, AnswerEntry>();
  for (const item of items) if (item.kind === "entry" && item.entry.kind === "answer") settled.set(item.entry.request, item.entry);
  for (const item of items) {
    if (item.kind === "earlier") rows.push({ kind: "earlier", key: "earlier" });
    else if (item.kind === "gap") rows.push({ kind: "gap", key: `gap${item.gap.after}`, gap: item.gap });
    else if (item.entry.kind === "user" && hidden(item.entry.source)) continue;
    else if (item.entry.kind === "answer") continue;
    else if (item.entry.kind === "tool" && item.entry.ask) rows.push(askRow(item.entry, item.entry.ask, settled.get(item.entry.ask.id)));
    else if (item.entry.kind === "tool" && item.entry.task && !item.entry.isError) rows.push(taskRow(item.entry, item.entry.task));
    else rows.push(rowForEntry(item.entry));
  }
  itemRowsCache.set(items, rows);
  return rows;
}

const waitingCache = new Map<string, TaskRow>();

export function waitingTaskRows(committed: readonly Row[], tasks: readonly TaskView[], bot: number): Row[] {
  const waiting = tasks.filter((t) => t.bot === bot && t.inputs.length > 0);
  for (const id of waitingCache.keys()) if (!waiting.some((t) => t.id === id)) waitingCache.delete(id);
  if (!waiting.length) return [];
  const shown = new Set(committed.flatMap((r) => (r.kind === "task" ? [r.task] : [])));
  return waiting
    .filter((t) => !shown.has(t.id))
    .map((t) => {
      let row = waitingCache.get(t.id);
      if (!row || row.title !== t.title) {
        row = { kind: "task", key: `waiting-${t.id}`, bot, task: t.id, title: t.title };
        waitingCache.set(t.id, row);
      }
      return row;
    });
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

export function tailRows(snapshot: ConversationSnapshot, working: boolean): Row[] {
  const rows: Row[] = [];
  if (working) rows.push(WORKING);
  for (const item of snapshot.inbox) {
    if (item.source) continue;
    rows.push(
      stable<QueuedMessage>(item, () => ({
        kind: "user",
        key: `m${item.requestId}`,
        text: item.text,
        ...(item.attachments ? { attachments: item.attachments } : {}),
        at: item.at,
        state: item.mode === "steer" ? "steer" : "queued",
      })),
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

export type ToolGroupRow = { readonly kind: "toolgroup"; readonly key: string; readonly entries: readonly ToolEntry[]; readonly at: number };
export type DisplayRow = Exclude<Row, { kind: "tool" }> | ToolGroupRow;
export type FilesRow = Extract<Row, { kind: "files" }>;

export function author(row: DisplayRow): "user" | "bot" | undefined {
  if (row.kind === "user") return "user";
  if (row.kind === "assistant" || row.kind === "toolgroup" || row.kind === "working" || row.kind === "ask" || row.kind === "task") return "bot";
  return undefined;
}

export function rowTime(row: DisplayRow | undefined): number | undefined {
  if (!row) return undefined;
  if (row.kind === "user" || row.kind === "assistant" || row.kind === "toolgroup") return row.at;
  return undefined;
}

const groupCache = new Map<string, ToolGroupRow>();
type AssistantRow = Extract<Row, { kind: "assistant" }>;
const withoutSearches = new WeakMap<AssistantRow, AssistantRow>();
function stepsHidden(row: AssistantRow): AssistantRow {
  if (!row.searches.length) return row;
  const known = withoutSearches.get(row);
  if (known) return known;
  const hidden: AssistantRow = { ...row, searches: NONE };
  withoutSearches.set(row, hidden);
  return hidden;
}
const filesCache = new Map<string, { parts: readonly FilesRow[]; row: FilesRow }>();

const CHANGE: Record<string, Record<string, FileChange["change"] | null>> = {
  added: { added: "added", changed: "added", removed: null },
  changed: { added: "changed", changed: "changed", removed: "removed" },
  removed: { added: "changed", changed: "changed", removed: "removed" },
};

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
  for (const next of rows) {
    const row = next.kind === "assistant" && !showTools ? stepsHidden(next) : next;
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
    if (row.kind === "assistant" && !row.text && !row.error && !row.searches.length) continue;
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
