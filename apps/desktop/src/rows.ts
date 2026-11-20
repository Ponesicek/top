import type {
  AgentSpawn,
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
  ToolCallView,
  TranscriptItem,
  WaitingTask,
  WebSearchStep,
} from "@top/client";
import { hasCitationMarker, pagesOpened, withoutCitationMarkers, withoutOpenAiTag } from "./citations.ts";

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
      readonly pagesRead?: readonly Citation[];
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
  | { readonly kind: "agent"; readonly key: string; readonly agent: AgentSpawn }
  | { readonly kind: "taskQuestion"; readonly key: string; readonly task: WaitingTask }
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

type AssistantRowData = Extract<Row, { kind: "assistant" }>;

// The pages the bot opened since the person's last message, up to and including rows[at];
// undefined when some of that turn isn't loaded.
function openedSince(rows: readonly Row[], at: number): Citation[] | undefined {
  const steps: WebSearchStep[] = [];
  for (let i = at; i >= 0; i--) {
    const row = rows[i]!;
    if (row.kind === "user") break;
    if (row.kind === "earlier" || row.kind === "gap") return undefined;
    if (row.kind === "assistant") steps.unshift(...row.searches);
  }
  return pagesOpened(steps);
}

// OpenAI didn't say which page a raw citation marker means, so the marker goes, and the answer lists the pages
// the bot read in that turn instead, apart from its Sources: they're what it read, not what a sentence cites.
const markedRows = new WeakMap<AssistantRowData, { signature: string; row: AssistantRowData }>();
function withoutMarkers(row: AssistantRowData, opened: Citation[] | undefined): AssistantRowData {
  const cited = new Set(row.citations.map((c) => withoutOpenAiTag(c.url)));
  const pagesRead = (opened ?? []).filter((page) => !cited.has(withoutOpenAiTag(page.url)));
  const signature = pagesRead.map((p) => p.url).join("\n");
  const known = markedRows.get(row);
  if (known?.signature === signature) return known.row;
  const next: AssistantRowData = { ...row, text: withoutCitationMarkers(row.text), ...(pagesRead.length ? { pagesRead } : {}) };
  markedRows.set(row, { signature, row: next });
  return next;
}

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

type AgentRow = Extract<Row, { kind: "agent" }>;
const agentRows = new WeakMap<ToolEntry, AgentRow>();

function agentRow(entry: ToolEntry, agent: AgentSpawn): AgentRow {
  let row = agentRows.get(entry);
  if (!row) {
    row = { kind: "agent", key: `e${entry.seq}`, agent };
    agentRows.set(entry, row);
  }
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
    else if (item.entry.kind === "tool" && item.entry.agent && !item.entry.isError) rows.push(agentRow(item.entry, item.entry.agent));
    else rows.push(rowForEntry(item.entry));
  }
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.kind === "assistant" && hasCitationMarker(row.text)) rows[i] = withoutMarkers(row, openedSince(rows, i));
  }
  itemRowsCache.set(items, rows);
  return rows;
}

const questionRows = new WeakMap<WaitingTask, Row>();

/** A task's questions get their own card at the end, wherever the task started. */
export function taskQuestionRows(tasks: readonly WaitingTask[], bot: number): Row[] {
  return tasks
    .filter((t) => t.bot === bot)
    .map((task) => {
      let row = questionRows.get(task);
      if (!row) {
        row = { kind: "taskQuestion", key: `question-${task.id}`, task };
        questionRows.set(task, row);
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
  if (
    row.kind === "assistant" ||
    row.kind === "toolgroup" ||
    row.kind === "working" ||
    row.kind === "ask" ||
    row.kind === "agent" ||
    row.kind === "taskQuestion"
  )
    return "bot";
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
    if (row.kind === "assistant" && !row.text && !row.error && !row.searches.length && !row.citations.length && !row.pagesRead) continue;
    flush();
    if (row.kind === "working" || row.kind === "taskQuestion" || author(row) !== "bot") flushFiles();
    out.push(row);
  }
  flush();
  flushFiles();
  if (groupCache.size > 5_000) groupCache.clear();
  if (filesCache.size > 2_000) filesCache.clear();
  return out;
}
