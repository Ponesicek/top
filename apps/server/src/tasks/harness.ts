import type { TaskDecision, TaskPolicy, TaskQuestion } from "@top/protocol";
import type { TObject } from "typebox";

export type Capabilities = {
  readonly resume: boolean;
  readonly fork: boolean;
  readonly steer: boolean;
  readonly queue: boolean;
  readonly approvals: boolean;
  readonly questions: boolean;
  readonly images: boolean;
  readonly fileChanges: boolean;
  readonly usage: boolean;
  readonly cancel: boolean;
  readonly reconnect: boolean;
};

export const CAPABILITY_NOTES: Record<keyof Capabilities, string> = {
  resume: "continue an earlier session in a new task (`session`)",
  fork: "branch a new session from an earlier one (`fork: true`)",
  steer: 'add a message to the turn that is running (`task_send` mode "steer")',
  queue: 'queue a message to run after the current turn (`task_send` mode "queue")',
  approvals: "ask for approval before acting outside its policy (answered with `task_respond` or by the user)",
  questions: "ask questions with options (answered with `task_respond` or by the user)",
  images: "take images with the prompt (`images`)",
  fileChanges: "report the files it changed",
  usage: "report token usage",
  cancel: "stop a running turn (`task_cancel`)",
  reconnect: "pick a session back up after its process ended, in a new task",
};

export type Turn = { readonly text: string; readonly images: readonly string[] };

export type HarnessRequest = {
  readonly id: string;
  readonly kind: "approval" | "question";
  readonly title: string;
  readonly detail?: string | undefined;
  readonly decisions?: readonly TaskDecision[] | undefined;
  readonly questions?: readonly TaskQuestion[] | undefined;
};

export type HarnessAnswer =
  | { readonly kind: "approval"; readonly decision: TaskDecision; readonly message?: string | undefined }
  | { readonly kind: "question"; readonly answers: Readonly<Record<string, readonly string[]>> }
  | { readonly kind: "cancelled" };

export type LogKind = "message" | "reasoning" | "command" | "file_change" | "tool" | "status" | "error";

export type Usage = { readonly inputTokens?: number; readonly outputTokens?: number; readonly cachedInputTokens?: number; readonly costUsd?: number };

export type HarnessEvent =
  | { readonly type: "session"; readonly externalId: string; readonly model?: string | undefined }
  | { readonly type: "log"; readonly kind: LogKind; readonly text: string }
  | { readonly type: "request"; readonly request: HarnessRequest }
  | { readonly type: "resolved"; readonly id: string }
  | { readonly type: "usage"; readonly usage: Usage }
  | {
      readonly type: "turn_ended";
      readonly status: "completed" | "failed" | "interrupted";
      readonly result?: string | undefined;
      readonly error?: string | undefined;
    }
  | { readonly type: "exited"; readonly error: string };

export type OpenSpec = {
  readonly cwd: string;
  readonly policy: TaskPolicy;
  readonly model: string | undefined;
  readonly options: Readonly<Record<string, unknown>>;
  readonly resume: string | undefined;
  readonly fork: boolean;
};

export interface HarnessSession {
  readonly run: (turn: Turn) => Promise<void>;
  readonly steer: (text: string) => Promise<void>;
  readonly interrupt: () => Promise<void>;
  readonly answer: (request: string, answer: HarnessAnswer) => void;
  readonly close: () => Promise<void>;
}

export type Availability = { readonly ok: true; readonly version: string } | { readonly ok: false; readonly error: string };

export interface HarnessAdapter {
  readonly id: string;
  readonly label: string;
  readonly capabilities: Capabilities;
  readonly options: TObject;
  readonly check: () => Promise<Availability>;
  readonly open: (spec: OpenSpec, emit: (event: HarnessEvent) => void) => Promise<HarnessSession>;
}

export class HarnessUnavailable extends Error {}

const SECRET_PATTERNS: readonly (readonly [RegExp, boolean])[] = [
  [/\bsk-[A-Za-z0-9_-]{12,}/g, false],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/-]{12,}=*/gi, true],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, false],
  [/("?(?:access_token|refresh_token|id_token|api[_-]?key|password|secret)"?\s*[:=]\s*"?)[^\s",}]{6,}/gi, true],
];

export function redact(text: string): string {
  let out = text;
  for (const [pattern, keep] of SECRET_PATTERNS) out = out.replace(pattern, (_match, lead: string) => (keep ? `${lead}[redacted]` : "[redacted]"));
  return out;
}

export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function tail(text: string, max: number): string {
  return text.length <= max ? text : `…${text.slice(-(max - 1))}`;
}

const PARENT_SESSION_VARS = new Set([
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_CHILD_NOTES_DIR",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_PID",
  "CLAUDE_AGENT_SDK_VERSION",
]);
const PROVIDER_KEYS = new Set([
  "AI_GATEWAY_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_OAUTH_TOKEN",
  "ANT_LING_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AZURE_OPENAI_API_KEY",
  "BASETEN_API_KEY",
  "CEREBRAS_API_KEY",
  "CLOUDFLARE_API_KEY",
  "COPILOT_GITHUB_TOKEN",
  "DEEPSEEK_API_KEY",
  "FIREWORKS_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_CLOUD_API_KEY",
  "GROQ_API_KEY",
  "HF_TOKEN",
  "KIMI_API_KEY",
  "META_API_KEY",
  "MINIMAX_API_KEY",
  "MINIMAX_CN_API_KEY",
  "MISTRAL_API_KEY",
  "MOONSHOT_API_KEY",
  "NVIDIA_API_KEY",
  "OPENAI_API_KEY",
  "OPENCODE_API_KEY",
  "OPENROUTER_API_KEY",
  "QWEN_TOKEN_PLAN_API_KEY",
  "QWEN_TOKEN_PLAN_CN_API_KEY",
  "RADIUS_API_KEY",
  "TOGETHER_API_KEY",
  "TYPESAFE_API_KEY",
  "XAI_API_KEY",
  "XIAOMI_API_KEY",
  "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
  "XIAOMI_TOKEN_PLAN_CN_API_KEY",
  "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
  "ZAI_API_KEY",
  "ZAI_CODING_CN_API_KEY",
]);

export function harnessEnv(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(env)) if (!PARENT_SESSION_VARS.has(name) && !PROVIDER_KEYS.has(name)) out[name] = value;
  return out;
}
