import { execFile, spawn } from "node:child_process";
import Type from "typebox";
import { clip, type HarnessAdapter, type HarnessEvent, HarnessUnavailable, harnessEnv, type OpenSpec, redact } from "./harness.ts";
import { RpcError, StdioRpc } from "./rpc.ts";

export const CODEX = "codex";

const EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const;

export const codexOptions = Type.Object(
  {
    reasoning_effort: Type.Optional(Type.Enum(EFFORTS, { description: "How hard the model thinks on each turn. Default: Codex's own setting." })),
  },
  { additionalProperties: false },
);

const UNEXPECTED: Record<string, { readonly what: string; readonly answer: unknown }> = {
  "item/commandExecution/requestApproval": { what: "to run a command", answer: { decision: "decline" } },
  "item/fileChange/requestApproval": { what: "to change files", answer: { decision: "decline" } },
  "item/permissions/requestApproval": { what: "for more permissions", answer: { permissions: {}, scope: "turn" } },
  execCommandApproval: { what: "to run a command", answer: { decision: "abort" } },
  applyPatchApproval: { what: "to change files", answer: { decision: "abort" } },
  "item/tool/requestUserInput": { what: "a question", answer: { answers: {} } },
};

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

type Item = { readonly type: string; readonly id: string } & Record<string, unknown>;

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
      questions: false,
      images: true,
      fileChanges: true,
      usage: true,
      cancel: true,
      reconnect: true,
      durable: false,
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
      const child = spawn(command, ["app-server"], { cwd: spec.cwd, env: harnessEnv(process.env), stdio: ["pipe", "pipe", "pipe"] });
      let threadId: string | undefined;
      let turnId: string | undefined;
      let active = false;
      let lastMessage: string | undefined;
      let ended = false;

      const rpc = new StdioRpc(child, {
        notification: (method, raw) => {
          const params = record(raw);
          if (params.threadId !== undefined && threadId !== undefined && params.threadId !== threadId) return;
          switch (method) {
            case "item/completed": {
              const item = record(params.item) as Item;
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
        request: (method, raw) => {
          const params = record(raw);
          const declined = UNEXPECTED[method];
          if (declined) {
            emit({ type: "log", kind: "error", text: `Codex asked ${declined.what} although Top runs it with approvals off; Top declined it.` });
            return Promise.resolve(declined.answer);
          }
          if (method === "mcpServer/elicitation/request") {
            emit({
              type: "log",
              kind: "status",
              text: `declined an MCP server's request for input (${str(params.serverName) ?? "server"}): Top doesn't relay those`,
            });
            return Promise.resolve({ action: "decline", content: null, _meta: null });
          }
          return Promise.reject(new RpcError(-32601, `Top doesn't handle ${method}`));
        },
        exit: (error) => {
          if (ended) return;
          ended = true;
          emit({ type: "exited", error: `Codex stopped: ${error}` });
        },
      });

      const fail = async (error: unknown): Promise<never> => {
        ended = true;
        await rpc.close(500);
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
          approvalPolicy: "never",
          sandbox: "danger-full-access",
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
                sandboxPolicy: { type: "dangerFullAccess" },
                approvalPolicy: "never",
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
        answer: () => {},
        close: async () => {
          ended = true;
          await rpc.close();
        },
      };
    },
  };
}
