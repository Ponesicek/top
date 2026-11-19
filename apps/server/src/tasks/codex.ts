import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskDecision, TaskPolicy, TaskQuestion } from "@top/protocol";
import Type from "typebox";
import { clip, type HarnessAdapter, type HarnessAnswer, type HarnessEvent, HarnessUnavailable, harnessEnv, type OpenSpec, redact } from "./harness.ts";
import { RpcError, type RpcId, StdioRpc } from "./rpc.ts";

export const CODEX = "codex";

const EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const;

export const codexOptions = Type.Object(
  {
    reasoning_effort: Type.Optional(Type.Enum(EFFORTS, { description: "How hard the model thinks on each turn. Default: Codex's own setting." })),
  },
  { additionalProperties: false },
);

const SANDBOX: Record<TaskPolicy, "read-only" | "workspace-write" | "danger-full-access"> = {
  read_only: "read-only",
  workspace_write: "workspace-write",
  full_access: "danger-full-access",
};
const APPROVAL: Record<TaskPolicy, "on-request" | "never"> = { read_only: "on-request", workspace_write: "on-request", full_access: "never" };

export function sandboxPolicyOf(policy: TaskPolicy, cwd: string, scratch: string | undefined) {
  switch (policy) {
    case "read_only":
      return { type: "readOnly", networkAccess: false };
    case "workspace_write":
      return {
        type: "workspaceWrite",
        writableRoots: scratch ? [cwd, scratch] : [cwd],
        networkAccess: false,
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: true,
      };
    case "full_access":
      return { type: "dangerFullAccess" };
  }
}

const QUIET = [
  "item/agentMessage/delta",
  "item/commandExecution/outputDelta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/textDelta",
  "item/reasoning/summaryPartAdded",
  "item/plan/delta",
  "item/fileChange/outputDelta",
  "turn/diff/updated",
];

const MAX_GRANT_TEXT = 1_500;
const APPROVAL_DECISIONS: readonly TaskDecision[] = ["allow", "allow_for_session", "deny"];

type Item = { readonly type: string; readonly id: string } & Record<string, unknown>;
type Pending = { readonly method: string; readonly params: Record<string, unknown>; readonly resolve: (result: unknown) => void };

const str = (value: unknown) => (typeof value === "string" ? value : undefined);
const record = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {});

function commandText(value: unknown): string {
  if (Array.isArray(value)) return value.map(String).join(" ");
  return str(value) ?? "";
}

function fileChanges(item: Record<string, unknown>): string[] {
  const changes = Array.isArray(item.changes) ? item.changes : [];
  return changes.map((change) => {
    const c = record(change);
    const kind = str(record(c.kind).type) ?? "update";
    return `${kind === "add" ? "+" : kind === "delete" ? "-" : "~"} ${str(c.path) ?? "?"}`;
  });
}

export function codexItemLog(item: Item): HarnessEvent | undefined {
  switch (item.type) {
    case "agentMessage":
      return { type: "log", kind: "message", text: str(item.text) ?? "" };
    case "reasoning": {
      const summary = Array.isArray(item.summary) ? item.summary.map(String).join("\n") : "";
      return summary ? { type: "log", kind: "reasoning", text: summary } : undefined;
    }
    case "commandExecution": {
      const exit = typeof item.exitCode === "number" ? ` (exit ${item.exitCode})` : "";
      const status = str(item.status);
      const output = str(item.aggregatedOutput)?.trim();
      return {
        type: "log",
        kind: "command",
        text: `$ ${commandText(item.command)}${exit}${status && status !== "completed" ? ` [${status}]` : ""}${output ? `\n${clip(output, 600)}` : ""}`,
      };
    }
    case "fileChange": {
      const status = str(item.status);
      return { type: "log", kind: "file_change", text: `${fileChanges(item).join("\n")}${status && status !== "completed" ? ` [${status}]` : ""}` };
    }
    case "mcpToolCall": {
      const error = str(record(item.error).message);
      return { type: "log", kind: "tool", text: `${str(item.server) ?? "mcp"}.${str(item.tool) ?? "?"}${error ? ` failed: ${error}` : ""}` };
    }
    case "webSearch":
      return { type: "log", kind: "tool", text: `web search${str(item.query) ? `: ${str(item.query)}` : ""}` };
    case "contextCompaction":
      return { type: "log", kind: "status", text: "compacted the conversation" };
    default:
      return undefined;
  }
}

function questionsOf(params: Record<string, unknown>): TaskQuestion[] {
  const list = Array.isArray(params.questions) ? params.questions : [];
  return list.map((raw, i) => {
    const q = record(raw);
    const options = Array.isArray(q.options) ? q.options.map(record) : [];
    return {
      id: str(q.id) ?? `q${i + 1}`,
      question: str(q.question) ?? "",
      ...(str(q.header) ? { header: str(q.header)! } : {}),
      options: options.map((o) => ({ label: str(o.label) ?? "", ...(str(o.description) ? { description: str(o.description)! } : {}) })),
      ...(q.isSecret === true ? { secret: true as const } : {}),
    };
  });
}

const v2Decision = (decision: TaskDecision) => (decision === "allow" ? "accept" : decision === "allow_for_session" ? "acceptForSession" : "decline");
const v1Decision = (decision: TaskDecision, message: string | undefined) =>
  decision === "allow" ? "approved" : decision === "allow_for_session" ? "approved_for_session" : { denied: { rejection: message ?? "The caller declined." } };

function respond(pending: Pending, answer: HarnessAnswer): unknown {
  const { method, params } = pending;
  if (answer.kind === "cancelled") {
    if (method === "item/tool/requestUserInput") return { answers: {} };
    if (method === "item/permissions/requestApproval") return { permissions: {}, scope: "turn" };
    if (method === "execCommandApproval" || method === "applyPatchApproval") return { decision: "abort" };
    return { decision: "cancel" };
  }
  if (method === "item/tool/requestUserInput") {
    if (answer.kind !== "question") return { answers: {} };
    return { answers: Object.fromEntries(Object.entries(answer.answers).map(([id, answers]) => [id, { answers: [...answers] }])) };
  }
  const decision = answer.kind === "approval" ? answer.decision : "deny";
  const message = answer.kind === "approval" ? answer.message : undefined;
  if (method === "item/permissions/requestApproval")
    return decision === "deny"
      ? { permissions: {}, scope: "turn" }
      : { permissions: record(params.permissions), scope: decision === "allow_for_session" ? "session" : "turn" };
  if (method === "execCommandApproval" || method === "applyPatchApproval") return { decision: v1Decision(decision, message) };
  return { decision: v2Decision(decision) };
}

export type CodexConfig = { readonly command?: string | undefined; readonly clientVersion?: string | undefined };

export function codexAdapter(config: CodexConfig = {}): HarnessAdapter {
  const command = config.command ?? process.env.TOP_CODEX_PATH ?? "codex";
  const missing = `Codex isn't installed on the daemon's computer (no \`${command}\` found). Install the Codex CLI, sign in with \`codex login\`, and try again; TOP_CODEX_PATH can point at it.`;

  return {
    id: CODEX,
    label: "Codex",
    capabilities: {
      resume: true,
      fork: true,
      steer: true,
      queue: true,
      approvals: true,
      questions: false,
      images: true,
      fileChanges: true,
      usage: true,
      cancel: true,
      reconnect: true,
    },
    options: codexOptions,
    check: () =>
      new Promise((resolve) => {
        execFile(command, ["--version"], { timeout: 10_000, env: harnessEnv(process.env) }, (error, stdout) => {
          if (error)
            resolve({ ok: false, error: (error as NodeJS.ErrnoException).code === "ENOENT" ? missing : `\`${command} --version\` failed: ${error.message}` });
          else resolve({ ok: true, version: stdout.trim() });
        });
      }),
    open: async (spec: OpenSpec, emit) => {
      const scratch = spec.policy === "workspace_write" ? await mkdtemp(join(tmpdir(), "top-codex-")) : undefined;
      const sandboxPolicy = sandboxPolicyOf(spec.policy, spec.cwd, scratch);
      const child = spawn(command, ["app-server"], {
        cwd: spec.cwd,
        env: { ...harnessEnv(process.env), ...(scratch ? { TMPDIR: scratch } : {}) },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const pending = new Map<string, Pending>();
      const items = new Map<string, Item>();
      let threadId: string | undefined;
      let turnId: string | undefined;
      let active = false;
      let lastMessage: string | undefined;
      let ended = false;

      const ask = (id: RpcId, method: string, params: Record<string, unknown>) =>
        new Promise<unknown>((resolve) => {
          const key = String(id);
          pending.set(key, { method, params, resolve });
          if (method === "item/tool/requestUserInput") {
            const questions = questionsOf(params);
            if (questions.some((q) => q.secret)) {
              pending.delete(key);
              emit({ type: "log", kind: "status", text: "declined a question asking for a secret: Codex keeps answers in its session history" });
              resolve({ answers: {} });
              return;
            }
            emit({ type: "request", request: { id: key, kind: "question", title: questions[0]?.question || "Codex has a question", questions } });
            return;
          }
          let title: string;
          let detail: string | undefined;
          if (method === "item/commandExecution/requestApproval" || method === "execCommandApproval") {
            const network = record(params.networkApprovalContext);
            title = str(network.host) ? `Reach ${str(network.host)} over the network` : `Run \`${clip(commandText(params.command), 300) || "a command"}\``;
            detail = [str(params.reason), str(params.cwd) ? `in ${str(params.cwd)}` : undefined].filter(Boolean).join("\n") || undefined;
          } else if (method === "item/fileChange/requestApproval" || method === "applyPatchApproval") {
            const item = items.get(str(params.itemId) ?? "");
            const files = item ? fileChanges(item) : Object.keys(record(params.fileChanges));
            title = `Change ${files.length === 1 ? "a file" : `${files.length || "some"} files`}${str(params.grantRoot) ? ` and write under ${str(params.grantRoot)}` : ""}`;
            detail = [clip(files.join("\n"), 1_000), str(params.reason)].filter(Boolean).join("\n") || undefined;
          } else {
            const permissions = record(params.permissions);
            const requested = JSON.stringify(permissions, null, 1);
            if (requested.length > MAX_GRANT_TEXT) {
              pending.delete(key);
              emit({ type: "log", kind: "status", text: "declined a permission request too large to show in full on a card" });
              resolve({ permissions: {}, scope: "turn" });
              return;
            }
            const fsys = record(permissions.fileSystem);
            const parts = [
              record(permissions.network).enabled === true ? "network access" : undefined,
              Array.isArray(fsys.write) && fsys.write.length ? `write access to ${fsys.write.join(", ")}` : undefined,
              Array.isArray(fsys.read) && fsys.read.length ? `read access to ${fsys.read.join(", ")}` : undefined,
            ].filter(Boolean);
            title = `Grant ${parts.join(" and ") || "more permissions"}`;
            detail = [str(params.reason), `Everything it asks for:\n${requested}`].filter(Boolean).join("\n");
          }
          emit({
            type: "request",
            request: { id: key, kind: "approval", title: clip(title, 400), ...(detail ? { detail: clip(detail, 2_000) } : {}), decisions: APPROVAL_DECISIONS },
          });
        });

      const rpc = new StdioRpc(child, {
        notification: (method, raw) => {
          const params = record(raw);
          if (params.threadId !== undefined && threadId !== undefined && params.threadId !== threadId) return;
          switch (method) {
            case "item/started": {
              const item = record(params.item) as Item;
              if (item.type === "fileChange") items.set(item.id, item);
              return;
            }
            case "item/completed": {
              const item = record(params.item) as Item;
              items.delete(item.id);
              if (item.type === "agentMessage" && str(item.text)) lastMessage = str(item.text);
              const log = codexItemLog(item);
              if (log) emit(log);
              return;
            }
            case "thread/tokenUsage/updated": {
              const total = record(record(params.tokenUsage).total);
              emit({
                type: "usage",
                usage: {
                  ...(typeof total.inputTokens === "number" ? { inputTokens: total.inputTokens } : {}),
                  ...(typeof total.outputTokens === "number" ? { outputTokens: total.outputTokens } : {}),
                  ...(typeof total.cachedInputTokens === "number" ? { cachedInputTokens: total.cachedInputTokens } : {}),
                },
              });
              return;
            }
            case "error": {
              const error = record(params.error);
              if (params.willRetry === true) emit({ type: "log", kind: "status", text: `retrying: ${str(error.message) ?? "error"}` });
              else emit({ type: "log", kind: "error", text: str(error.message) ?? "error" });
              return;
            }
            case "serverRequest/resolved": {
              const id = String(params.requestId);
              if (pending.delete(id)) emit({ type: "resolved", id });
              return;
            }
            case "turn/started": {
              if (active && turnId === undefined) turnId = str(record(params.turn).id);
              return;
            }
            case "turn/completed": {
              const turn = record(params.turn);
              if (!active || (turnId !== undefined && str(turn.id) !== turnId)) return;
              active = false;
              turnId = undefined;
              const status = str(turn.status);
              const error = str(record(turn.error).message);
              for (const [id, request] of pending) {
                request.resolve(respond(request, { kind: "cancelled" }));
                emit({ type: "resolved", id });
              }
              pending.clear();
              const result = lastMessage;
              lastMessage = undefined;
              emit({
                type: "turn_ended",
                status: status === "completed" ? "completed" : status === "interrupted" ? "interrupted" : "failed",
                ...(result ? { result } : {}),
                ...(error ? { error } : status !== "completed" && status !== "interrupted" ? { error: `the turn ended as ${status ?? "unknown"}` } : {}),
              });
              return;
            }
            default:
              return;
          }
        },
        request: (method, raw, id) => {
          const params = record(raw);
          switch (method) {
            case "item/commandExecution/requestApproval":
            case "item/fileChange/requestApproval":
            case "item/permissions/requestApproval":
            case "item/tool/requestUserInput":
            case "execCommandApproval":
            case "applyPatchApproval":
              return ask(id, method, params);
            case "mcpServer/elicitation/request":
              emit({
                type: "log",
                kind: "status",
                text: `declined an MCP server's request for input (${str(params.serverName) ?? "server"}): Top doesn't relay those`,
              });
              return Promise.resolve({ action: "decline", content: null, _meta: null });
            default:
              return Promise.reject(new RpcError(-32601, `Top doesn't handle ${method}`));
          }
        },
        exit: (error) => {
          if (ended) return;
          ended = true;
          emit({ type: "exited", error: `Codex stopped: ${error}` });
        },
      });

      const cleanup = () => (scratch ? rm(scratch, { recursive: true, force: true }).catch(() => {}) : Promise.resolve());
      const fail = async (error: unknown): Promise<never> => {
        ended = true;
        await rpc.close(500);
        await cleanup();
        if (error instanceof HarnessUnavailable) throw error;
        const message = error instanceof Error ? error.message : String(error);
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT" || /ENOENT/.test(message)) throw new HarnessUnavailable(missing);
        throw new Error(`Codex didn't start: ${redact(message)}`);
      };

      try {
        await rpc.request("initialize", {
          clientInfo: { name: "top", title: "Top", version: config.clientVersion ?? "0" },
          capabilities: { experimentalApi: false, requestAttestation: false, optOutNotificationMethods: QUIET },
        });
        rpc.notify("initialized", {});
        const account = record(await rpc.request("account/read", { refreshToken: false }));
        if (account.requiresOpenaiAuth === true && (account.account === null || account.account === undefined))
          throw new HarnessUnavailable("Codex isn't signed in on the daemon's computer. Run `codex login` there, then try again.");
        const overrides = {
          cwd: spec.cwd,
          approvalPolicy: APPROVAL[spec.policy],
          approvalsReviewer: "user",
          sandbox: SANDBOX[spec.policy],
          ...(spec.model ? { model: spec.model } : {}),
        };
        const started = record(
          spec.resume
            ? await rpc.request(spec.fork ? "thread/fork" : "thread/resume", { threadId: spec.resume, ...overrides, excludeTurns: true })
            : await rpc.request("thread/start", overrides),
        );
        const thread = record(started.thread);
        threadId = str(thread.id);
        if (!threadId) throw new Error("Codex started no thread");
        emit({ type: "session", externalId: threadId, ...(str(started.model) ? { model: str(started.model)! } : {}) });
      } catch (error) {
        return fail(error);
      }

      const effort = typeof spec.options.reasoning_effort === "string" ? spec.options.reasoning_effort : undefined;
      const input = (text: string, images: readonly string[] = []) => [
        { type: "text", text, text_elements: [] },
        ...images.map((path) => ({ type: "localImage", path })),
      ];

      return {
        run: async (turn) => {
          active = true;
          turnId = undefined;
          try {
            const started = record(
              await rpc.request("turn/start", {
                threadId,
                input: input(turn.text, turn.images),
                sandboxPolicy,
                approvalPolicy: APPROVAL[spec.policy],
                approvalsReviewer: "user",
                ...(effort ? { effort } : {}),
              }),
            );
            if (active && turnId === undefined) turnId = str(record(started.turn).id);
          } catch (error) {
            active = false;
            throw error;
          }
        },
        steer: async (text) => {
          if (!turnId) throw new Error("Codex has no turn running to steer");
          await rpc.request("turn/steer", { threadId, input: input(text), expectedTurnId: turnId });
        },
        interrupt: async () => {
          if (!turnId) return;
          await rpc.request("turn/interrupt", { threadId, turnId }, 15_000).catch(() => {});
        },
        answer: (id, answer) => {
          const request = pending.get(id);
          if (!request) return;
          pending.delete(id);
          request.resolve(respond(request, answer));
        },
        close: async () => {
          ended = true;
          for (const request of pending.values()) request.resolve(respond(request, { kind: "cancelled" }));
          pending.clear();
          await rpc.close();
          await cleanup();
        },
      };
    },
  };
}
