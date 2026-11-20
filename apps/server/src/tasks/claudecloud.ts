import { join } from "node:path";
import Type from "typebox";
import { duration } from "../time.ts";
import { inPrivateDir, limiter, type Ran, refuse, runCli, SKIPPED, said, stripAnsi } from "./cloud.ts";
import { type Availability, findCli, type HarnessAdapter, type HarnessEvent, harnessEnv, type OpenSpec, redact, type Turn } from "./harness.ts";

/**
 * Claude Code cloud, through the official `claude --cloud` and its claude.ai sign-in (code.claude.com/docs/en/claude-code-on-the-web.md):
 * `claude --cloud "<task>"` starts a cloud session for the repository it runs in; `claude -p --cloud <session> --output-format json`
 * queues one message into a session, the message on stdin, and prints `{ok, session_id, url}` or `{ok: false, session_id, error}`.
 * There's no way to read a session's progress, status or result from the CLI, nor to stop one, so Top only hands work off.
 *
 * A new session runs in a fresh clone of the one branch named, in a private folder, never in the user's checkouts: Claude Code
 * cloud clones it from GitHub, or uploads it as a bundle (when the Claude GitHub App isn't on the repository) with that branch's
 * code and full history. `CCR_FORCE_BUNDLE` is taken out of its environment, so Top never asks for a bundle itself.
 */
export const CLAUDE_CLOUD = "claude-cloud";

const SESSION_ID = /^(?:session|cse)_[A-Za-z0-9]{1,200}$/;
/** A link starts a line or follows a space, so one inside another link (its query or fragment) is never taken. */
const LINK = /(?:^|\s)(https:\/\/claude\.ai\/code\/\S+)/gm;
const SESSION_PATH = /^\/code\/((?:session|cse)_[A-Za-z0-9]{1,200})$/;
const SESSION_LINE = /^Session ID: ((?:session|cse)_[A-Za-z0-9]{1,200})\s*$/m;
export const claudeSessionUrl = (id: string) => `https://claude.ai/code/${id}`;
/** `claude --cloud` takes the task on its command line, which is bounded; longer goes in the repository. */
export const MAX_CLOUD_PROMPT_BYTES = 100_000;

export const claudeCloudOptions = Type.Object(
  {
    repo: Type.String({
      pattern: "^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})/(?!\\.)(?!.*\\.git$)[A-Za-z0-9._-]{1,100}$",
      description: 'required: the GitHub repository, "owner/name"',
    }),
    branch: Type.String({
      pattern: "^(?!-)(?!.*\\.\\.)(?!.*//)(?!.*\\.lock$)[A-Za-z0-9._/-]{1,200}$",
      description: "required: the branch the session starts from, as pushed to GitHub",
    }),
  },
  { additionalProperties: false },
);

export type ClaudeCloudConfig = {
  readonly command?: string | undefined;
  readonly git?: string | undefined;
  readonly cloneTimeoutMs?: number | undefined;
  /** How long `claude --cloud` may take, uploading included, before Top stops it. */
  readonly startTimeoutMs?: number | undefined;
  readonly sendTimeoutMs?: number | undefined;
};

/** What `--cloud` says when it refuses before it starts anything (the docs' troubleshooting tables): a definite no, not a maybe. */
const REFUSED = [
  /Cloud sessions aren't available/,
  /Cloud sessions are disabled by your organization's policy/,
  /Cloud sessions need a claude\.ai sign-in/,
  /Couldn't verify your organization's policy for cloud sessions/,
  /Unable to get organization UUID/,
  /Attaching to an existing cloud session is not enabled/,
  /Session not found: /,
  /is archived and cannot accept new messages/,
];

const SIGN_IN = "run `claude auth login` and sign in with your claude.ai account";

/** Variables that point git (and the `claude` that reads the repository) at another repository than the clone. */
const REPO_VARS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
];

function cloudEnv(): Record<string, string | undefined> {
  const env = harnessEnv(process.env);
  delete env.CCR_FORCE_BUNDLE;
  for (const name of REPO_VARS) delete env[name];
  return env;
}

/** A session's id from an official claude.ai/code link: the origin and path checked as a URL, the query dropped. */
export function sessionOfLink(text: string): string | undefined {
  for (const match of stripAnsi(text).matchAll(LINK)) {
    let url: URL;
    try {
      url = new URL(match[1]!);
    } catch {
      continue;
    }
    const id = url.origin === "https://claude.ai" ? SESSION_PATH.exec(url.pathname)?.[1] : undefined;
    if (id) return id;
  }
  return undefined;
}

/** An id that `redact` would change is never kept: it would be saved and shown as something else. */
function idIn(output: string): string | undefined {
  const id = sessionOfLink(output) ?? SESSION_LINE.exec(stripAnsi(output))?.[1];
  return id && redact(id) === id ? id : undefined;
}

/** With `--cloud`, a prompt that is only a session id or link attaches to that session instead of starting one. */
function looksLikeSession(prompt: string): boolean {
  const text = prompt.trim();
  return !/\s/.test(text) && (SESSION_ID.test(text) || text.includes("claude.ai/code"));
}

function jsonIn(stdout: string): Record<string, unknown> | undefined {
  for (const line of stripAnsi(stdout).trim().split("\n").reverse()) {
    try {
      const value = JSON.parse(line) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
    } catch {}
  }
  return undefined;
}

export function claudeCloudAdapter(config: ClaudeCloudConfig = {}): HarnessAdapter {
  const command = config.command ?? process.env.TOP_CLAUDE_PATH ?? "claude";
  const cli = () => findCli(command, "Claude Code", "TOP_CLAUDE_PATH", `Install Claude Code, then ${SIGN_IN}`);
  const git = () => findCli(config.git ?? "git", "git", "PATH", "Install git");
  const cloneTimeoutMs = config.cloneTimeoutMs ?? 5 * 60_000;
  const startTimeoutMs = config.startTimeoutMs ?? 10 * 60_000;
  const sendTimeoutMs = config.sendTimeoutMs ?? 2 * 60_000;
  const calls = limiter(2);

  const check = async (): Promise<Availability> => {
    let path: string;
    try {
      path = await cli();
      await git();
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    const run = (args: string[]) => inPrivateDir("claude-cloud", (cwd) => runCli(path, args, { cwd, env: cloudEnv(), timeoutMs: 15_000 }));
    const version = await run(["--version"]);
    if (version.code !== 0) return { ok: false, error: `\`${command} --version\` failed${version.spawnError ? `: ${version.spawnError}` : ""}.` };
    const help = await run(["--help"]);
    if (!/--cloud\b/.test(help.stdout))
      return { ok: false, error: `This Claude Code (${said(version.stdout, 80)}) has no \`--cloud\`. Update Claude Code and try again.` };
    // Only the kind of sign-in is read: nothing else it prints is kept or shown.
    const status = await run(["auth", "status", "--json"]);
    const method = jsonIn(status.stdout)?.authMethod;
    if (method === "claude.ai") return { ok: true, version: said(version.stdout, 80) };
    if (method === undefined || method === "none")
      return { ok: false, error: `Claude Code isn't signed in, and Claude Code cloud needs a claude.ai sign-in: ${SIGN_IN}.` };
    return {
      ok: false,
      error: `Claude Code is signed in with ${typeof method === "string" ? said(method, 40).replace(/[^a-z_.]/gi, "") : "something else"}, and Claude Code cloud needs a claude.ai sign-in: ${SIGN_IN}.`,
    };
  };

  return {
    id: CLAUDE_CLOUD,
    label: "Claude Code cloud",
    where: "cloud",
    guidance:
      "Each task starts a session on GitHub's `repo` at `branch`, from a fresh clone of that branch made just for it, never from a folder here. Claude Code cloud receives that branch's code and its full history, including anything sensitive in older commits: cloned from GitHub, or uploaded as a bundle when the Claude GitHub App isn't on the repository. Top only hands it off: the task ends `handed_off` with the session's link, and Top can't see its progress or result. Continuing its session (`session`) queues one message into it, which isn't a live steer; that it was queued doesn't mean it's done.",
    capabilities: {
      resume: true,
      fork: false,
      steer: false,
      queue: false,
      questions: false,
      images: false,
      fileChanges: false,
      usage: false,
      cancel: false,
      reconnect: false,
      durable: false,
      follow: false,
    },
    options: claudeCloudOptions,
    check,
    locate: async (cwd, { options, model }) => {
      if (cwd !== undefined) throw new Error("Claude Code cloud takes no `cwd`: it works on `repo` at `branch`, cloned fresh for it.");
      if (model !== undefined) throw new Error("Claude Code cloud picks the session's model itself here: leave out `model`.");
      return { cwd: `github.com/${String(options.repo)} @ ${String(options.branch)}` };
    },
    open: async (spec: OpenSpec, emit: (event: HarnessEvent) => void) => {
      const path = await cli();
      const repo = String(spec.options.repo ?? "");
      const branch = String(spec.options.branch ?? "");
      let closed = false;
      const end = (event: Omit<Extract<HarnessEvent, { type: "turn_ended" }>, "type">) => {
        if (!closed) emit({ type: "turn_ended", ...event });
      };
      const log = (text: string) => {
        if (!closed) emit({ type: "log", kind: "status", text });
      };
      /** A CLI call in its turn, unless this session closed while it waited: then nothing is started. One already running finishes. */
      const call = (work: () => Promise<Ran>) => calls(() => (closed ? Promise.resolve(SKIPPED) : work()));

      /** A new session: a clone of the one branch, `claude --cloud` in it, then the clone is removed. */
      const start = async (turn: Turn) => {
        if (Buffer.byteLength(turn.text) > MAX_CLOUD_PROMPT_BYTES)
          return end({
            status: "failed",
            error: `It wasn't sent: \`claude --cloud\` takes the task on its command line, at most ${MAX_CLOUD_PROMPT_BYTES / 1000} kB. Put long material in the repository and point at it.`,
          });
        if (looksLikeSession(turn.text))
          return end({
            status: "failed",
            error:
              "It wasn't sent: a prompt that is only a session id or claude.ai/code link would attach to that session rather than start one. Say what to do in words, or continue the session with `session`.",
          });
        const gitPath = await git();
        // What it ended as is said once the clone is gone.
        const outcome = await inPrivateDir("claude-cloud", async (dir): Promise<() => void> => {
          const checkout = join(dir, "repo");
          log(`cloning github.com/${repo} at ${branch} (that branch only) into a private folder`);
          const clone = await runCli(gitPath, ["clone", "--single-branch", "--branch", branch, "--", `https://github.com/${repo}.git`, checkout], {
            cwd: dir,
            env: { ...cloudEnv(), GIT_TERMINAL_PROMPT: "0" },
            timeoutMs: cloneTimeoutMs,
          });
          if (clone.code !== 0)
            return () =>
              end({
                status: "failed",
                error: `It wasn't sent: Top couldn't clone github.com/${repo} at ${branch}: ${said(clone.stderr, 400) || clone.spawnError || (clone.timedOut ? "it timed out" : `exit ${clone.code}`)}`,
              });
          // `--branch` takes a tag too: only a checkout of the branch itself starts the session.
          const head = await runCli(gitPath, ["-C", checkout, "symbolic-ref", "--short", "HEAD"], {
            cwd: dir,
            env: { ...cloudEnv(), GIT_TERMINAL_PROMPT: "0" },
            timeoutMs: 30_000,
          });
          if (head.code !== 0 || head.stdout.trim() !== branch)
            return () => end({ status: "failed", error: `It wasn't sent: ${branch} isn't a branch of github.com/${repo}.` });
          if (closed) return () => {};
          log("starting a Claude Code cloud session");
          let seen: string | undefined;
          const ran = await call(() =>
            runCli(path, ["--cloud", turn.text, "--name", spec.title], {
              cwd: checkout,
              env: cloudEnv(),
              timeoutMs: startTimeoutMs,
              // Once the session's id is out, it's handed off; the CLI is left to finish (it may still be uploading the bundle),
              // up to its time limit, so the session isn't cut off from its code.
              onOutput: (stdout, stderr) => {
                const id = seen ?? idIn(`${stdout}\n${stderr}`);
                if (id && !seen) {
                  seen = id;
                  if (!closed) emit({ type: "session", externalId: id });
                  log(`started ${claudeSessionUrl(id)}`);
                }
              },
            }),
          );
          if (ran.skipped) return () => {};
          return () => handedOff(ran, seen ?? idIn(`${ran.stdout}\n${ran.stderr}`));
        });
        outcome();
      };

      const handedOff = (ran: Ran, id: string | undefined) => {
        const output = stripAnsi(`${ran.stdout}\n${ran.stderr}`);
        if (id) {
          if (!closed) emit({ type: "session", externalId: id });
          const branchNote = /^Branch .* is not on GitHub.*$/m.exec(output)?.[0];
          const tail = ran.timedOut
            ? ` (Top stopped \`claude --cloud\` after ${duration(startTimeoutMs)}; the session had already started.)`
            : ran.code !== 0
              ? ` (\`claude --cloud\` ended with exit ${ran.code} after starting it: ${said(ran.stderr, 300)})`
              : "";
          const moved = branchNote
            ? `\nThe session did NOT start from ${branch}: Claude Code says "${said(branchNote, 300)}". It works on that instead, not on ${branch}.`
            : "";
          return end({
            status: "handed_off",
            result: `Sent to Claude Code cloud: ${claudeSessionUrl(id)}. Top can't see its progress or result there.${moved}${tail}`,
          });
        }
        const why = said(ran.stderr || ran.stdout, 600) || ran.spawnError || (ran.timedOut ? "it didn't finish in time" : `exit ${ran.code}`);
        if (ran.spawnError || (!ran.timedOut && REFUSED.some((pattern) => pattern.test(output))))
          return end({ status: "failed", error: `Claude Code cloud didn't take it: ${why}` });
        end({
          status: "failed",
          error: `Claude Code cloud may or may not have started a session for it (${ran.timedOut ? `\`claude --cloud\` didn't finish within ${duration(startTimeoutMs)}` : why}). Check https://claude.ai/code before starting it again: Top never retries it.`,
        });
      };

      /** A follow-up: one message queued into the session, nothing more. */
      const send = async (session: string, turn: Turn) => {
        if (!SESSION_ID.test(session)) return end({ status: "failed", error: `It wasn't sent: ${session} isn't a Claude Code cloud session id.` });
        const ran = await call(() =>
          inPrivateDir("claude-cloud", (cwd) =>
            runCli(path, ["-p", "--cloud", session, "--output-format", "json"], { cwd, env: cloudEnv(), input: turn.text, timeoutMs: sendTimeoutMs }),
          ),
        );
        if (ran.skipped) return;
        const reply = jsonIn(ran.stdout);
        const url = claudeSessionUrl(session);
        if (reply?.ok === true) {
          return end({
            status: "handed_off",
            result: `Queued a message into Claude Code cloud session ${url}. It's a queued message, not a live steer: Top can't see whether or when the session acts on it, or its result.`,
          });
        }
        if (reply?.ok === false)
          return end({ status: "failed", error: `Claude Code cloud didn't take the message: ${said(String(reply.error ?? "no reason given"), 600)}` });
        const why = said(ran.stderr || ran.stdout, 600) || ran.spawnError || (ran.timedOut ? "it didn't finish in time" : `exit ${ran.code}`);
        if (ran.spawnError || (!ran.timedOut && REFUSED.some((pattern) => pattern.test(stripAnsi(ran.stderr)))))
          return end({ status: "failed", error: `Claude Code cloud didn't take the message: ${why}` });
        end({
          status: "failed",
          error: `The message may or may not have reached ${url} (${ran.timedOut ? `no answer within ${duration(sendTimeoutMs)}` : why}). Check the session before sending it again: Top never resends it.`,
        });
      };

      const guard = (work: Promise<void>) =>
        work.catch((error: unknown) =>
          end({ status: "failed", error: `Top failed while handing it off: ${error instanceof Error ? error.message : String(error)}` }),
        );

      return {
        run: async (turn) => {
          if (closed) throw new Error("closed");
          if (turn.followOnly) setTimeout(() => end({ status: "interrupted" }));
          else if (spec.resume && !spec.fork) void guard(send(spec.resume, turn));
          else void guard(start(turn));
        },
        steer: refuse("Claude Code cloud", "take messages into a running hand-off"),
        interrupt: refuse("Claude Code cloud", "stop a session"),
        answer: () => {},
        close: async () => {
          closed = true;
        },
      };
    },
  };
}
