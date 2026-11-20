import Type from "typebox";
import { duration } from "../time.ts";
import { inPrivateDir, limiter, refuse, runCli, said, stripAnsi } from "./cloud.ts";
import { type Availability, findCli, type HarnessAdapter, type HarnessEvent, harnessEnv, type OpenSpec, redact, type Turn } from "./harness.ts";

/**
 * Claude Code cloud, through the official `claude` CLI and its claude.ai sign-in (code.claude.com/docs/en/claude-code-on-the-web.md):
 * `claude -p --cloud <session> --output-format json` queues one message into an existing cloud session, the message on stdin,
 * and prints `{ok, session_id, url}` or `{ok: false, session_id, error}`.
 *
 * Top can't start a session: the CLI (2.1.329) only starts one in an interactive terminal ("Without an interactive terminal,
 * --cloud can only send the prompt to an existing cloud session"). The user starts it (claude.ai/code, the Claude app, or
 * `claude --cloud` in their own terminal) and gives its id or link. There's no way to read a session's progress, status or
 * result from the CLI, nor to stop one, so Top only queues messages. It runs in an empty private folder: nothing from this
 * computer's checkouts goes with them.
 */
export const CLAUDE_CLOUD = "claude-cloud";

const SESSION_ID = /^(?:session|cse)_[A-Za-z0-9]{1,200}$/;
const SESSION_PATH = /^\/code\/((?:session|cse)_[A-Za-z0-9]{1,200})$/;
export const claudeSessionUrl = (id: string) => `https://claude.ai/code/${id}`;

/**
 * The bare id of a session given as its id or its claude.ai/code link (the link checked as a URL: origin and path, the query
 * dropped). Anything else, or an id that `redact` would change (it would be saved and shown as something else), is undefined.
 */
export function cloudSessionId(given: string): string | undefined {
  const text = given.trim();
  let id: string | undefined;
  if (SESSION_ID.test(text)) id = text;
  else if (text.startsWith("https://")) {
    try {
      const url = new URL(text);
      id = url.origin === "https://claude.ai" ? SESSION_PATH.exec(url.pathname)?.[1] : undefined;
    } catch {}
  }
  return id && redact(id) === id ? id : undefined;
}

export const claudeCloudOptions = Type.Object(
  {
    cloud_session: Type.String({
      description: "required: the Claude Code cloud session the user started, as its id (session_… or cse_…) or its https://claude.ai/code/… link",
    }),
  },
  { additionalProperties: false },
);

export type ClaudeCloudConfig = {
  readonly command?: string | undefined;
  readonly sendTimeoutMs?: number | undefined;
};

/** What `--cloud <session>` says when it refuses (the docs' troubleshooting tables): a definite no, not a maybe. */
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

function cloudEnv(): Record<string, string | undefined> {
  const env = harnessEnv(process.env);
  delete env.CCR_FORCE_BUNDLE;
  return env;
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
  const sendTimeoutMs = config.sendTimeoutMs ?? 2 * 60_000;
  const calls = limiter(2);

  const check = async (): Promise<Availability> => {
    let path: string;
    try {
      path = await cli();
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
      "Top can't start a Claude Code cloud session: the official CLI only starts one in an interactive terminal. The user starts it (on claude.ai/code, in the Claude app, or with `claude --cloud` in their own terminal) and gives you its id or link for `cloud_session`. Each task queues one message into that session, which isn't a live steer: the task ends `handed_off`, and Top can't see whether or when the session acts on it, or its result. Top uploads nothing from this computer's checkouts. To send it more later, start a task with that task's `session`.",
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
      if (cwd !== undefined) throw new Error("Claude Code cloud takes no `cwd`: it queues messages into the session in `cloud_session`.");
      if (model !== undefined) throw new Error("Claude Code cloud keeps the session's own model: leave out `model`.");
      const id = cloudSessionId(String(options.cloud_session ?? ""));
      if (!id)
        throw new Error(
          "`cloud_session` has to be a Claude Code cloud session's id (session_… or cse_…) or its https://claude.ai/code/… link. Top can't start one: ask the user to start it and give you its id or link.",
        );
      return { cwd: `claude.ai/code/${id}`, options: { cloud_session: id } };
    },
    open: async (spec: OpenSpec, emit: (event: HarnessEvent) => void) => {
      const path = await cli();
      const session = spec.resume ?? cloudSessionId(String(spec.options.cloud_session ?? ""));
      if (!session) throw new Error("There's no Claude Code cloud session to send to: give its id or link in `cloud_session`.");
      // Saved at once, so a later task with this Top session sends to the same cloud session.
      emit({ type: "session", externalId: session });
      let closed = false;
      const end = (event: Omit<Extract<HarnessEvent, { type: "turn_ended" }>, "type">) => {
        if (!closed) emit({ type: "turn_ended", ...event });
      };

      /** One message queued into the session, nothing more. */
      const send = async (turn: Turn) => {
        const ran = await calls(() =>
          inPrivateDir("claude-cloud", (cwd) =>
            runCli(path, ["-p", "--cloud", session, "--output-format", "json"], {
              cwd,
              env: cloudEnv(),
              input: turn.text,
              timeoutMs: sendTimeoutMs,
              // Closed by the time it would start (asked after its folder is made, just before the process): never sent.
              skip: () => closed,
            }),
          ),
        );
        if (ran.skipped) return;
        const reply = jsonIn(ran.stdout);
        const url = claudeSessionUrl(session);
        if (reply?.ok === true)
          return end({
            status: "handed_off",
            result: `Queued a message into Claude Code cloud session ${url}. It's a queued message, not a live steer: Top can't see whether or when the session acts on it, or its result.`,
          });
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

      return {
        run: async (turn) => {
          if (closed) throw new Error("closed");
          if (turn.followOnly) setTimeout(() => end({ status: "interrupted" }));
          else
            void send(turn).catch((error: unknown) =>
              end({ status: "failed", error: `Top failed while sending it: ${error instanceof Error ? error.message : String(error)}` }),
            );
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
