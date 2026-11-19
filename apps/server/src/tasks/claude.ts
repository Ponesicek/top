import { type ExecFileException, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { delimiter, extname, join } from "node:path";
import type { CanUseTool, Options, PermissionResult, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { TaskQuestion } from "@top/protocol";
import Type from "typebox";
import {
  clip,
  type HarnessAdapter,
  type HarnessAnswer,
  type HarnessEvent,
  HarnessUnavailable,
  harnessEnv,
  type OpenSpec,
  redact,
  type Turn,
  tail,
} from "./harness.ts";

export const CLAUDE_CODE = "claude_code";

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const MIN_CLI = [2, 1, 200] as const;
const SETTLE_MS = 60_000;

export const claudeOptions = Type.Object(
  {
    effort: Type.Optional(Type.Enum(EFFORTS, { description: "How much effort Claude puts into each answer. Default: Claude Code's own setting." })),
    max_turns: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, description: "Stop a turn after this many model round trips." })),
  },
  { additionalProperties: false },
);

const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

type Query_ = Pick<Query, "close"> &
  AsyncIterable<SDKMessage> & {
    readonly interrupt: (options?: { readonly cancelQueued?: boolean }) => Promise<unknown>;
  };
export type QueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => Query_;

const str = (value: unknown) => (typeof value === "string" ? value : undefined);
const record = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {});

export function claudeToolLog(name: string, input: Record<string, unknown>): HarnessEvent {
  switch (name) {
    case "Bash":
      return { type: "log", kind: "command", text: `$ ${clip(str(input.command) ?? "", 600)}` };
    case "Edit":
    case "Write":
    case "MultiEdit":
    case "NotebookEdit":
      return { type: "log", kind: "file_change", text: `${name === "Write" ? "+" : "~"} ${str(input.file_path) ?? str(input.notebook_path) ?? "?"}` };
    default: {
      const hint = str(input.file_path) ?? str(input.pattern) ?? str(input.path) ?? str(input.url) ?? str(input.description) ?? "";
      return { type: "log", kind: "tool", text: hint ? `${name}: ${clip(hint, 200)}` : name };
    }
  }
}

type Pending = {
  readonly resolve: (result: PermissionResult) => void;
  readonly input: Record<string, unknown>;
  readonly questions: readonly { readonly id: string; readonly text: string }[];
};

function result(pending: Pending, answer: HarnessAnswer): PermissionResult {
  if (answer.kind === "cancelled") return { behavior: "deny", message: "The question was withdrawn.", interrupt: false };
  const answers: Record<string, string> = {};
  for (const q of pending.questions) {
    const given = answer.answers[q.id];
    if (given?.length) answers[q.text] = given.join(", ");
  }
  return { behavior: "allow", updatedInput: { ...pending.input, answers } };
}

class Inbox implements AsyncIterable<SDKUserMessage> {
  readonly #queue: SDKUserMessage[] = [];
  #wake: (() => void) | undefined;
  #done = false;

  push(message: SDKUserMessage) {
    this.#queue.push(message);
    this.#wake?.();
  }

  end() {
    this.#done = true;
    this.#wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    for (;;) {
      const next = this.#queue.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.#done) return;
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
      this.#wake = undefined;
    }
  }
}

async function onPath(name: string): Promise<string | undefined> {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return undefined;
}

const versionAtLeast = (version: string, min: readonly number[]) => {
  const parts = /(\d+)\.(\d+)\.(\d+)/.exec(version)?.slice(1).map(Number);
  if (!parts) return true;
  for (let i = 0; i < min.length; i++) if (parts[i] !== min[i]) return (parts[i] ?? 0) > min[i]!;
  return true;
};

const run = (command: string, args: string[]) =>
  new Promise<{ ok: true; stdout: string } | { ok: false; error: ExecFileException; stdout: string }>((resolve) =>
    execFile(command, args, { timeout: 15_000, env: harnessEnv(process.env) }, (error, stdout) =>
      resolve(error ? { ok: false, error, stdout } : { ok: true, stdout }),
    ),
  );

export type ClaudeConfig = {
  readonly command?: string | undefined;
  readonly query?: QueryFn | undefined;
  readonly clientVersion?: string | undefined;
};

export function claudeAdapter(config: ClaudeConfig = {}): HarnessAdapter {
  const command = config.command ?? process.env.TOP_CLAUDE_PATH ?? "claude";
  const missing = `Claude Code isn't installed on the daemon's computer (no \`${command}\` found). Install Claude Code, sign in by running \`claude\` once, and try again; TOP_CLAUDE_PATH can point at it.`;
  const authFailedText = "Claude Code couldn't authenticate on the daemon's computer. Check that `claude` works there on its own, and sign in by running it.";
  const signIn = "Claude Code isn't signed in on the daemon's computer. Run `claude` there and sign in, then try again.";
  let resolved: string | undefined;
  const loadQuery = async (): Promise<QueryFn> => config.query ?? ((await import("@anthropic-ai/claude-agent-sdk")).query as unknown as QueryFn);

  const locate = async () => {
    if (!resolved) resolved = command.includes("/") ? command : await onPath(command);
    if (!resolved) throw new HarnessUnavailable(missing);
    return resolved;
  };

  return {
    id: CLAUDE_CODE,
    label: "Claude Code",
    capabilities: {
      resume: true,
      fork: true,
      steer: true,
      queue: true,
      questions: true,
      images: true,
      fileChanges: true,
      usage: true,
      cancel: true,
      reconnect: true,
    },
    options: claudeOptions,
    check: async () => {
      let path: string;
      try {
        path = await locate();
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      const version = await run(path, ["--version"]);
      if (!version.ok) return { ok: false, error: version.error.code === "ENOENT" ? missing : `\`${command} --version\` failed: ${version.error.message}` };
      const text = version.stdout.trim();
      if (process.getuid?.() === 0)
        return {
          ok: false,
          error: "Claude Code won't run with its permission checks off as root, and Top runs it that way. Run Top's daemon as a normal user.",
        };
      if (!versionAtLeast(text, MIN_CLI))
        return { ok: false, error: `Claude Code ${text} is too old for Top; update it to ${MIN_CLI.join(".")} or newer (\`claude update\`).` };
      const status = await run(path, ["auth", "status", "--json"]);
      try {
        const parsed = record(JSON.parse(status.stdout));
        if (parsed.loggedIn === false) return { ok: false, error: signIn };
      } catch {}
      return { ok: true, version: text };
    },
    open: async (spec: OpenSpec, emit) => {
      const path = await locate();
      const query = await loadQuery();
      const inbox = new Inbox();
      const abort = new AbortController();
      const pending = new Map<string, Pending>();
      let stderr = "";
      let turnActive = false;
      let interrupting = false;
      let ended = false;
      let sessionId = spec.resume && !spec.fork ? spec.resume : randomUUID();

      const canUseTool: CanUseTool = (name, input, options) =>
        new Promise<PermissionResult>((resolve) => {
          const id = options.toolUseID || randomUUID();
          const settle = (value: PermissionResult) => {
            if (!pending.delete(id)) return;
            resolve(value);
          };
          options.signal.addEventListener(
            "abort",
            () => {
              if (pending.has(id)) {
                settle({ behavior: "deny", message: "Withdrawn." });
                emit({ type: "resolved", id });
              }
            },
            { once: true },
          );
          if (name === "AskUserQuestion") {
            const raw = Array.isArray(input.questions) ? input.questions.map(record) : [];
            const questions: TaskQuestion[] = raw.map((q, i) => ({
              id: `q${i + 1}`,
              question: str(q.question) ?? "",
              ...(str(q.header) ? { header: str(q.header)! } : {}),
              options: (Array.isArray(q.options) ? q.options.map(record) : []).map((o) => ({
                label: str(o.label) ?? "",
                ...(str(o.description) ? { description: str(o.description)! } : {}),
              })),
              ...(q.multiSelect === true ? { multiple: true as const } : {}),
            }));
            pending.set(id, {
              resolve: settle,
              input,
              questions: questions.map((q) => ({ id: q.id, text: q.question })),
            });
            emit({ type: "request", request: { id, title: questions[0]?.question || "Claude has a question", questions } });
            return;
          }
          resolve({ behavior: "deny", message: "Top runs Claude Code with permission checks off and has no way to ask about this." });
          emit({ type: "log", kind: "error", text: `Claude Code asked to allow ${name} although permission checks are off; Top declined it.` });
        });

      const options: Options = {
        cwd: spec.cwd,
        pathToClaudeCodeExecutable: path,
        env: { ...harnessEnv(process.env), CLAUDE_AGENT_SDK_CLIENT_APP: `top/${config.clientVersion ?? "0"}` },
        abortController: abort,
        canUseTool,
        systemPrompt: { type: "preset", preset: "claude_code" },
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        sandbox: { enabled: false },
        ...(spec.model ? { model: spec.model } : {}),
        ...(spec.resume ? { resume: spec.resume } : { sessionId }),
        ...(spec.resume && spec.fork ? { forkSession: true, sessionId } : {}),
        ...(typeof spec.options.effort === "string" ? { effort: spec.options.effort as (typeof EFFORTS)[number] } : {}),
        ...(typeof spec.options.max_turns === "number" ? { maxTurns: spec.options.max_turns } : {}),
        stderr: (data) => {
          stderr = tail(stderr + data, 4_000);
        },
      };

      let q: Query_;
      try {
        q = query({ prompt: inbox, options });
      } catch (error) {
        throw new Error(`Claude Code didn't start: ${redact(error instanceof Error ? error.message : String(error))}`);
      }
      let announced = false;
      const outstanding = new Set<string>();

      let parked: Extract<HarnessEvent, { type: "turn_ended" }> | undefined;
      let settle: NodeJS.Timeout | undefined;
      let lastEnding: Extract<HarnessEvent, { type: "turn_ended" }> | undefined;
      const giveUp = () => {
        settle = undefined;
        if (!parked) return;
        if (pending.size) {
          settle = setTimeout(giveUp, SETTLE_MS);
          return;
        }
        outstanding.clear();
        endTurn(parked);
      };
      const park = (event: Extract<HarnessEvent, { type: "turn_ended" }>) => {
        if (settle) clearTimeout(settle);
        parked = event;
        settle = setTimeout(giveUp, SETTLE_MS);
      };
      const endTurn = (event: Extract<HarnessEvent, { type: "turn_ended" }>) => {
        if (settle) clearTimeout(settle);
        settle = undefined;
        parked = undefined;
        lastEnding = undefined;
        if (!turnActive) return;
        turnActive = false;
        const status = interrupting && event.status !== "completed" ? "interrupted" : event.status;
        interrupting = false;
        for (const [id, request] of pending) {
          request.resolve(result(request, { kind: "cancelled" }));
          emit({ type: "resolved", id });
        }
        pending.clear();
        emit({ ...event, status });
      };

      let authFailed = false;
      void (async () => {
        try {
          for await (const message of q) {
            if (parked && message.type === "assistant" && !message.parent_tool_use_id) {
              if (settle) clearTimeout(settle);
              settle = undefined;
              parked = undefined;
            }
            if (
              message.type === "system" &&
              message.subtype === "session_state_changed" &&
              message.state === "idle" &&
              turnActive &&
              lastEnding &&
              pending.size === 0
            ) {
              outstanding.clear();
              endTurn(lastEnding);
            }
            switch (message.type) {
              case "system":
                if (message.subtype === "init" && message.session_id && (!announced || message.session_id !== sessionId)) {
                  announced = true;
                  sessionId = message.session_id;
                  emit({ type: "session", externalId: sessionId, ...(message.model ? { model: message.model } : {}) });
                }
                break;
              case "assistant": {
                if (message.error === "authentication_failed") authFailed = true;
                if (message.parent_tool_use_id) break;
                for (const block of message.message.content) {
                  if (block.type === "text" && block.text.trim()) emit({ type: "log", kind: "message", text: block.text });
                  else if (block.type === "tool_use" && block.name !== "AskUserQuestion") emit(claudeToolLog(block.name, record(block.input)));
                }
                break;
              }
              case "result": {
                const answered = message.user_message_uuids ?? (message.user_message_uuid ? [message.user_message_uuid] : undefined);
                if (answered?.length) for (const uuid of answered) outstanding.delete(uuid);
                else outstanding.clear();
                const usage = record(message.usage);
                emit({
                  type: "usage",
                  usage: {
                    ...(typeof usage.input_tokens === "number" ? { inputTokens: usage.input_tokens } : {}),
                    ...(typeof usage.output_tokens === "number" ? { outputTokens: usage.output_tokens } : {}),
                    ...(typeof usage.cache_read_input_tokens === "number" ? { cachedInputTokens: usage.cache_read_input_tokens } : {}),
                    ...(typeof message.total_cost_usd === "number" ? { costUsd: message.total_cost_usd } : {}),
                  },
                });
                let ending: Extract<HarnessEvent, { type: "turn_ended" }>;
                if (message.subtype === "success" && !message.is_error) ending = { type: "turn_ended", status: "completed", result: message.result };
                else {
                  const text =
                    message.subtype === "success"
                      ? message.result
                      : [message.subtype === "error_max_turns" ? "It reached the turn limit (max_turns)." : "", ...(message.errors ?? [])]
                          .filter(Boolean)
                          .join("\n");
                  ending = {
                    type: "turn_ended",
                    status: "failed",
                    error: authFailed ? `${authFailedText} (${clip(redact(text), 300)})` : redact(text || message.subtype),
                  };
                  authFailed = false;
                }
                lastEnding = ending;
                if (outstanding.size > 0 && !interrupting) park(ending);
                else endTurn(ending);
                break;
              }
              default:
                break;
            }
          }
          if (!ended) {
            ended = true;
            emit({ type: "exited", error: `Claude Code stopped${stderr ? `: ${tail(redact(stderr.trim()), 600)}` : ""}` });
          }
        } catch (error) {
          if (ended) return;
          ended = true;
          const message = error instanceof Error ? error.message : String(error);
          emit({ type: "exited", error: `Claude Code stopped: ${redact(message)}${stderr ? `\n${tail(redact(stderr.trim()), 600)}` : ""}` });
        }
      })();

      const userMessage = async (text: string, images: readonly string[], priority?: "next"): Promise<SDKUserMessage> => {
        const blocks = await Promise.all(
          images.map(async (path) => ({
            type: "image" as const,
            source: {
              type: "base64" as const,
              media_type: IMAGE_TYPES[extname(path).toLowerCase()] as "image/png",
              data: (await readFile(path)).toString("base64"),
            },
          })),
        );
        const uuid = randomUUID();
        outstanding.add(uuid);
        return {
          type: "user",
          uuid,
          message: { role: "user", content: blocks.length ? [{ type: "text", text }, ...blocks] : text },
          parent_tool_use_id: null,
          origin: { kind: "human" },
          ...(priority ? { priority } : {}),
        } as SDKUserMessage;
      };

      return {
        run: async (turn: Turn) => {
          if (ended) throw new Error("Claude Code isn't running");
          turnActive = true;
          inbox.push(await userMessage(turn.text, turn.images));
        },
        steer: async (text) => {
          if (ended || !turnActive) throw new Error("Claude Code has no turn running to steer");
          inbox.push(await userMessage(text, [], "next"));
        },
        interrupt: async () => {
          if (!turnActive) return;
          interrupting = true;
          outstanding.clear();
          if (parked) endTurn({ type: "turn_ended", status: "interrupted" });
          await Promise.race([q.interrupt({ cancelQueued: true }).catch(() => {}), new Promise((resolve) => setTimeout(resolve, 15_000))]);
        },
        answer: (id, answer) => {
          const request = pending.get(id);
          if (request) request.resolve(result(request, answer));
        },
        close: async () => {
          ended = true;
          if (settle) clearTimeout(settle);
          for (const request of pending.values()) request.resolve(result(request, { kind: "cancelled" }));
          pending.clear();
          inbox.end();
          try {
            q.close();
          } catch {}
          abort.abort();
        },
      };
    },
  };
}
