// Whose work a run in a T3 Code thread is, from what T3 Code saved about it: Top's, a person's, or nobody's that Top can prove.

type Rec = Record<string, unknown>;
const record = (value: unknown): Rec => (typeof value === "object" && value !== null ? (value as Rec) : {});
const str = (value: unknown) => (typeof value === "string" ? value : undefined);

/**
 * - top: Top's work. `task` is the Top task that already took the run (or the run its chain leads back to); `key` the
 *   Top turn whose message started the chain. Neither, when nobody but Top had written in the thread before the run, so
 *   a wake comes from Top's work even without a link: a wake can only come from work that was there before it.
 * - human: started by someone in T3 Code itself (or another agent through it), or caused by such a run.
 * - monitor: only acknowledges a monitor's progress; never anyone's answer.
 * - unknown: a wake with no link to what caused it, in a thread someone else had written in before it.
 */
export type Owner =
  | { readonly kind: "top"; readonly task?: string | undefined; readonly key?: string | undefined }
  | { readonly kind: "human" }
  | { readonly kind: "monitor" }
  | { readonly kind: "unknown" };

/** How Top already accounted for a run: the task that took it, or why no task did. */
export type Accounted = { readonly task: string | null; readonly kind: string };

export type ThreadRecords = {
  readonly runs: ReadonlyMap<string, Rec>;
  /** The thread's user-role messages, by id. */
  readonly messages: ReadonlyMap<string, Rec>;
  readonly subagents: ReadonlyMap<string, Rec>;
};

/**
 * A message someone wrote in T3 Code, or another agent sent into the thread through it (MCP, with the thread it came
 * from); Top's own messages have `top:` ids.
 */
const byPerson = (m: Rec) =>
  m.role === "user" && !String(m.id).startsWith("top:") && (m.createdBy === "user" || m.creationSource === "mcp" || str(m.senderThreadId) !== undefined);

/**
 * A run that answers nothing: a monitor's progress line, or a compaction T3 Code ran on its own while the thread was
 * idle. A pull request watch's news (a review, an approval, a close) is real work.
 */
export const isMonitorProgress = (m: Rec | undefined) => {
  // T3 Code's own `/compact` (`idleCompactionOf`): marked as such, or, from servers before that, sent by its server.
  const compact = str(m?.text)?.trim().toLowerCase() === "/compact" && !(Array.isArray(m?.attachments) && m.attachments.length);
  if (compact && (m?.idleCompaction !== undefined || (m?.createdBy === "agent" && m?.creationSource === "server"))) return true;
  if (m?.idleCompaction !== undefined) return true;
  const notification = record(m?.notification);
  const source = record(notification.source);
  return source.kind === "monitor" && notification.outcome === "updated" && source.pullRequest === undefined && source.otherPullRequests === undefined;
};

const childRuns = (records: ThreadRecords) => {
  const byChild = new Map<string, string>();
  for (const task of records.subagents.values()) {
    const child = str(task.childThreadId);
    if (child && str(task.runId)) byChild.set(child, str(task.runId)!);
  }
  return byChild;
};

/** The runs T3 Code says a run came from: the run it continues, the run whose delegated work woke it, a child's run. */
export function causes(records: ThreadRecords) {
  const runByChild = childRuns(records);
  return (runId: string): string[] => {
    const run = records.runs.get(runId);
    if (!run) return [];
    const continues = str(run.restartContinuationOfRunId) ?? str(run.manualContinuationOfRunId) ?? str(run.usageLimitContinuationOfRunId);
    if (continues) return [continues];
    const message = records.messages.get(String(run.userMessageId ?? ""));
    if (!message) return [];
    const parent = str(record(message.delegatedCompletion).parentRunId);
    if (parent) return [parent];
    const source = record(record(message.notification).source);
    const child = str(source.childThreadId);
    if (child && runByChild.has(child)) return [runByChild.get(child)!];
    const tasks = Array.isArray(source.taskIds) ? source.taskIds.map(String) : [];
    return tasks.map((id) => str(records.subagents.get(id)?.runId)).filter((id): id is string => id !== undefined);
  };
}

/** Whether a run came from `from` through T3 Code's links, however many wakes later. */
export function descendsFrom(cause: (runId: string) => string[], runId: string, from: string): boolean {
  const seen = new Set<string>();
  const todo = [runId];
  while (todo.length) {
    const next = todo.pop()!;
    if (next === from) return true;
    if (seen.has(next)) continue;
    seen.add(next);
    todo.push(...cause(next));
  }
  return false;
}

export function owners(records: ThreadRecords, accounted: ReadonlyMap<string, Accounted> = new Map()) {
  const known = new Map<string, Owner>();
  // When someone else first wrote in the thread; a time Top can't read counts as before everything.
  const firstOther = Math.min(
    ...[...records.messages.values()].filter(byPerson).map((m) => {
      const at = Date.parse(str(m.createdAt) ?? "");
      return Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY;
    }),
  );
  const othersBefore = (run: Rec) => {
    const at = Date.parse(str(run.requestedAt) ?? str(run.startedAt) ?? "");
    return firstOther !== Number.POSITIVE_INFINITY && (!Number.isFinite(at) || firstOther <= at);
  };
  // Runs someone else wrote into after they started (a steer in T3 Code): what they answer is no longer only Top's work.
  const steeredByOthers = new Set<string>();
  for (const m of records.messages.values()) {
    const run = str(m.runId);
    if (run && byPerson(m) && records.runs.get(run)?.userMessageId !== m.id) steeredByOthers.add(run);
  }
  const runByChild = childRuns(records);

  const ownerOf = (runId: string, path: Set<string> = new Set()): Owner => {
    const cached = known.get(runId);
    if (cached) return cached;
    if (path.has(runId)) return { kind: "unknown" };
    path.add(runId);
    const found = resolve(runId, path);
    known.set(runId, found);
    return found;
  };

  const combine = (found: readonly Owner[]): Owner => {
    if (found.some((o) => o.kind === "human")) return { kind: "human" };
    const tops = found.filter((o): o is Extract<Owner, { kind: "top" }> => o.kind === "top");
    if (tops.length && tops.length === found.length) return tops[0]!;
    return { kind: "unknown" };
  };

  const resolve = (runId: string, path: Set<string>): Owner => {
    const taken = accounted.get(runId);
    if (taken?.task && !steeredByOthers.has(runId)) return { kind: "top", task: taken.task };
    if (taken?.kind === "human") return { kind: "human" };
    const run = records.runs.get(runId);
    if (!run) return { kind: "unknown" };
    const messageId = String(run.userMessageId ?? "");
    if (messageId.startsWith("top:")) return { kind: "top", key: messageId.slice(4) };
    if (steeredByOthers.has(runId)) return { kind: "human" };
    // A run T3 Code restarted or continued is the work it continues.
    const continues = str(run.restartContinuationOfRunId) ?? str(run.manualContinuationOfRunId) ?? str(run.usageLimitContinuationOfRunId);
    if (continues) return ownerOf(continues, path);
    const message = records.messages.get(messageId);
    if (!message) return othersBefore(run) ? { kind: "unknown" } : { kind: "top", ...lastTopBefore(run) };
    const parent = str(record(message.delegatedCompletion).parentRunId);
    if (parent) return ownerOf(parent, path);
    if (isMonitorProgress(message)) return { kind: "monitor" };
    const source = record(record(message.notification).source);
    const child = str(source.childThreadId);
    const fromChild = child ? runByChild.get(child) : undefined;
    if (fromChild) return ownerOf(fromChild, path);
    const tasks = Array.isArray(source.taskIds) ? source.taskIds.map(String) : [];
    const fromTasks = tasks.map((id) => str(records.subagents.get(id)?.runId)).filter((id): id is string => id !== undefined);
    if (fromTasks.length) return combine(fromTasks.map((id) => ownerOf(id, path)));
    if (byPerson(message)) return { kind: "human" };
    // A wake that names nothing it came from: Top's only if nobody else had written in the thread before it, and then
    // the Top turn that ran last before it stands for it (by T3 Code's own order, whatever Top has done since).
    return othersBefore(run) ? { kind: "unknown" } : { kind: "top", ...lastTopBefore(run) };
  };
  const lastTopBefore = (run: Rec) => {
    const before = [...records.runs.values()]
      .filter((r) => String(r.userMessageId ?? "").startsWith("top:") && Number(r.ordinal) < Number(run.ordinal))
      .sort((a, b) => Number(b.ordinal) - Number(a.ordinal))[0];
    return before ? { key: String(before.userMessageId).slice(4) } : {};
  };

  return ownerOf;
}
