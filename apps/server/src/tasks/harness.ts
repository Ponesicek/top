import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import type { TaskQuestion } from "@top/protocol";
import type { TObject } from "typebox";
import type { Accounted, Owner } from "./t3owner.ts";

export type Capabilities = {
  readonly resume: boolean;
  readonly fork: boolean;
  readonly steer: boolean;
  readonly queue: boolean;
  readonly questions: boolean;
  readonly images: boolean;
  readonly fileChanges: boolean;
  readonly usage: boolean;
  readonly cancel: boolean;
  readonly reconnect: boolean;
  readonly durable: boolean;
  /**
   * Set only by a cloud harness. false: Top hands the work off and can't see how it goes there, so the task ends `handed_off`.
   * Left out, as the harnesses on a computer leave it, Top follows the work to its end, as it always has.
   */
  readonly follow?: boolean;
};

export const CAPABILITY_NOTES: Record<keyof Capabilities, string> = {
  resume: "continue an earlier session in a new task (`session`)",
  fork: "branch a new session from an earlier one (`fork: true`)",
  steer: 'add a message to the turn that is running (`task_send` mode "steer")',
  queue: 'queue a message to run after the current turn (`task_send` mode "queue")',
  questions: "ask questions with options (answered with `task_respond` or by the user)",
  images: "take images with the prompt (`images`)",
  fileChanges: "report the files it changed",
  usage: "report token usage",
  cancel: "stop a running turn (`task_cancel`)",
  reconnect: "pick a session back up after its process ended, in a new task",
  durable: "keeps working through a restart of Top, which follows it again when it's back",
  follow:
    "Top follows the work to its end and reports its result. A cloud harness that can't only hands the work off: the task ends `handed_off`, which means Top doesn't know how it goes; its progress and result are at the session's link",
};

/**
 * `key` is unique to this turn in Top and the same when a restart sends it again, so a durable harness can take it once.
 * `followOnly`: a cancel came before Top restarted, so follow the turn if the harness already has it, but never send it.
 * `adopt`: a run the harness started on its own in the session (see `watch`): follow it as this turn, sending nothing.
 * `known`: runs in the session other tasks already reported, which this turn never reports again.
 */
export type Turn = {
  readonly key: string;
  readonly text: string;
  readonly images: readonly string[];
  readonly followOnly?: boolean;
  readonly adopt?: string | undefined;
  readonly known?: readonly string[] | undefined;
};

export type HarnessRequest = {
  readonly id: string;
  readonly title: string;
  readonly questions: readonly TaskQuestion[];
};

export type HarnessAnswer = { readonly kind: "question"; readonly answers: Readonly<Record<string, readonly string[]>> } | { readonly kind: "cancelled" };

export type LogKind = "message" | "reasoning" | "command" | "file_change" | "tool" | "status" | "error";

export type Usage = { readonly inputTokens?: number; readonly outputTokens?: number; readonly cachedInputTokens?: number; readonly costUsd?: number };

export type HarnessEvent =
  | {
      readonly type: "session";
      readonly externalId: string;
      readonly model?: string | undefined;
      /** Told once the id is saved (or that it couldn't be), so a harness can record that it is about to send work before it sends it. */
      readonly saved?: ((error?: Error) => void) | undefined;
    }
  | { readonly type: "log"; readonly kind: LogKind; readonly text: string }
  | { readonly type: "request"; readonly request: HarnessRequest }
  | { readonly type: "resolved"; readonly id: string }
  | { readonly type: "usage"; readonly usage: Usage }
  | {
      readonly type: "turn_ended";
      /** `handed_off`: a cloud harness took the work and Top can't follow it; `result` says where it is. */
      readonly status: "completed" | "failed" | "interrupted" | "handed_off";
      readonly result?: string | undefined;
      readonly error?: string | undefined;
    }
  /** The turn's own work is over and it only waits on work it delegated: it needs no execution slot meanwhile. */
  | { readonly type: "held" }
  | { readonly type: "exited"; readonly error: string };

export type OpenSpec = {
  readonly session: string;
  /** The task's title: a harness that names what it starts names it this, as the conversation's card does. */
  readonly title: string;
  readonly cwd: string;
  readonly model: string | undefined;
  readonly options: Readonly<Record<string, unknown>>;
  readonly resume: string | undefined;
  readonly fork: boolean;
};

export interface HarnessSession {
  readonly run: (turn: Turn) => Promise<void>;
  readonly steer: (text: string) => Promise<void>;
  readonly interrupt: () => Promise<void>;
  /** A harness that confirms answers returns a promise, rejected when it refuses one, so the request waits again. */
  readonly answer: (request: string, answer: HarnessAnswer) => void | Promise<void>;
  readonly close: () => Promise<void>;
  /**
   * For a harness that can run on its own in a session (`watch`): the runs this turn reported, which no later task
   * reports again, and, for a session Top accounts for the first time, the ones that had ended before it.
   */
  readonly covered?: () => { readonly runs: readonly string[]; readonly earlier: readonly string[] };
}

/** A run in a watched session, in the order the harness ran them, and whose work it is (see `t3owner.ts`). */
export type ReviewedRun = {
  readonly run: string;
  readonly ended: boolean;
  readonly owner: Owner;
};

/** A session's thread as the harness's change feed last showed it. */
export type WatchedThread = {
  readonly externalId: string;
  readonly archived: boolean;
  /** Its newest run and the one going, when the feed says: a thread whose runs Top accounted for already needs no look. */
  readonly latestRunId?: string | null | undefined;
  readonly activeRunId?: string | null | undefined;
};

export interface SessionWatch {
  /** Every run in the session's thread, with whose work each is, given how Top accounted for some already. */
  /** `environment`: the one the session belongs to; a review against another is refused. */
  readonly review: (externalId: string, accounted: ReadonlyMap<string, Accounted>, environment: string | undefined) => Promise<readonly ReviewedRun[]>;
  readonly close: () => void;
}

export type Availability = { readonly ok: true; readonly version: string } | { readonly ok: false; readonly error: string };

export type Where = "local" | "remote" | "cloud";

export interface HarnessAdapter {
  readonly id: string;
  readonly label: string;
  /**
   * Where the work runs. Left out: on the daemon's computer, or on another one when it has `locate`. "cloud": in its vendor's
   * cloud, against a repository or environment named in its options, never a local folder.
   */
  readonly where?: Where;
  /** What a bot has to know to use it, beyond its options, said under its line in `task_start`. */
  readonly guidance?: string;
  readonly capabilities: Capabilities;
  readonly options: TObject;
  readonly check: () => Promise<Availability>;
  /** Whether `task_start` offers it to the bots now, asked before each of their turns (default: always). Its sessions carry on either way. */
  readonly offered?: () => boolean;
  /**
   * For a harness on another computer: checks `cwd` there (Top doesn't look at its own disk) and returns the folder to use,
   * with options the new session keeps (which computer it belongs to), set by the harness and not by the bot.
   */
  readonly locate?: (
    cwd: string | undefined,
    start: { readonly options: Readonly<Record<string, unknown>>; readonly model: string | undefined },
  ) => Promise<{ readonly cwd: string; readonly options?: Readonly<Record<string, unknown>> }>;
  readonly open: (spec: OpenSpec, emit: (event: HarnessEvent) => void) => Promise<HarnessSession>;
  /**
   * For a harness that runs on its own in a session after a task ends (T3 Code waking a thread when delegated work reports
   * back): one feed of the threads that changed, for the whole environment, kept up through drops until closed. Which
   * environment it is reaches `environment`, so sessions that belong to another are left alone.
   */
  readonly watch?: (changed: (threads: readonly WatchedThread[], environment: string) => void) => SessionWatch;
}

export class HarnessUnavailable extends Error {}

/** Runs in its vendor's cloud. */
export const inCloud = (adapter: Pick<HarnessAdapter, "where">) => adapter.where === "cloud";
/** Top follows its work to the end (every harness but a cloud one that says it can't). */
export const follows = (capabilities: Capabilities) => capabilities.follow !== false;

const executable = async (path: string) => {
  try {
    if (!(await stat(path)).isFile()) return false;
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * Finds a harness's CLI. A path is used as given (made absolute); a bare name is looked up on PATH and then in ~/.local/bin,
 * where Claude Code's and Codex's installers put them. A service's PATH (systemd's, launchd's) leaves that
 * folder out even when the user's terminal has it.
 */
export async function findCli(command: string, label: string, envVar: string, install: string): Promise<string> {
  if (command.includes("/")) {
    // Absolute, so a relative override still names the same file when a task runs in another folder. Not
    // normalized: `link/..` has to mean what the filesystem says it does.
    const path = isAbsolute(command) ? command : `${process.cwd()}/${command}`;
    if (await executable(path)) return path;
    throw new HarnessUnavailable(
      `${label} isn't at \`${command}\`: there's no executable file there on the daemon's computer. Point ${envVar} at it, or unset ${envVar}.`,
    );
  }
  const local = join(homedir(), ".local", "bin");
  for (const dir of [...(process.env.PATH ?? "").split(delimiter), local]) {
    if (!dir) continue;
    const candidate = join(dir, command);
    if (await executable(candidate)) return candidate;
  }
  throw new HarnessUnavailable(
    `${label} isn't installed on the daemon's computer (no \`${command}\` on its PATH or in ${local}). ${install}, and try again; ${envVar} can point at it.`,
  );
}

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
  // A parent SDK app's name; some gateways refuse Claude Code traffic that carries one.
  "CLAUDE_AGENT_SDK_CLIENT_APP",
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
