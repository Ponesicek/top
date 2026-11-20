import Type from "typebox";
import { duration } from "../time.ts";
import { inPrivateDir, limiter, type Ran, refuse, runCli, said, stripAnsi } from "./cloud.ts";
import { type Availability, findCli, type HarnessAdapter, type HarnessEvent, harnessEnv, type OpenSpec, redact, type Turn } from "./harness.ts";

/**
 * Codex cloud, through the official `codex cloud` CLI and its ChatGPT sign-in. What it prints is read from the CLI's source at
 * rust-v0.171.0 (codex-rs/cloud-tasks/src/lib.rs, util.rs): `exec` prints the task's URL and nothing else on stdout; `status`
 * prints `[PENDING|READY|APPLIED|ERROR] <title>`, a line with the environment and when it changed, then `+A/-D • N files` or
 * `no diff`, and exits 1 for anything but READY; `diff` prints the attempt's unified diff. Every `codex cloud` command appends
 * to an `error.log` (with the account id) in the folder it runs in, so each runs in a private folder, removed after.
 */
export const CODEX_CLOUD = "codex-cloud";

const ID = "[A-Za-z0-9][A-Za-z0-9_-]{0,199}";
/** The only task links taken: `util::task_url` on the ChatGPT backend. Anything else on stdout is ignored. */
const TASK_URL = new RegExp(`^https://chatgpt\\.com/codex/tasks/(${ID})$`);
export const codexTaskUrl = (id: string) => `https://chatgpt.com/codex/tasks/${id}`;
const PENDING = "pending:";

export const codexCloudOptions = Type.Object(
  {
    environment: Type.String({
      pattern: "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$",
      description: "required: the Codex cloud environment's id, from the user (`codex cloud exec --env`)",
    }),
    branch: Type.String({
      pattern: "^(?!-)(?!.*\\.\\.)(?!.*//)[A-Za-z0-9._/-]{1,200}$",
      description: "required: the branch it starts from (`--branch`); never guessed from a checkout here",
    }),
    attempts: Type.Optional(Type.Integer({ minimum: 1, maximum: 4, description: "how many attempts Codex cloud makes, 1 to 4 (`--attempts`; default 1)" })),
  },
  { additionalProperties: false },
);

export type CodexCloudConfig = {
  readonly command?: string | undefined;
  /** The first wait between status checks; each wait after doubles, up to `maxPollMs`. */
  readonly firstPollMs?: number | undefined;
  readonly maxPollMs?: number | undefined;
  /** How long Top follows one task before it stops and says its status is unknown. */
  readonly followForMs?: number | undefined;
  readonly submitTimeoutMs?: number | undefined;
  readonly checkTimeoutMs?: number | undefined;
};

/** `exec` failed before it created anything: these come from `codex cloud` before its create call (lib.rs). */
const NOT_SENT = [
  /Not signed in\. Please run 'codex login'/,
  /environment id must not be empty/,
  /no cloud environments are available/,
  /environment '.*' not found/,
  /environment label '.*' is ambiguous/,
  /no query provided/,
  /^error: (?:unexpected argument|invalid value|the following required arguments|unrecognized subcommand)/m,
];

type Status = { readonly state: "PENDING" | "READY" | "APPLIED" | "ERROR"; readonly title: string; readonly summary: string };

export function parseCodexStatus(stdout: string): Status | undefined {
  const lines = stripAnsi(stdout)
    .split("\n")
    .map((l) => l.trim());
  const head = /^\[(PENDING|READY|APPLIED|ERROR)\]\s*(.*)$/.exec(lines[0] ?? "");
  if (!head) return undefined;
  return { state: head[1] as Status["state"], title: head[2] ?? "", summary: lines[2] ?? "" };
}

/** The files a unified diff touches, as the task log shows file changes: `+ added`, `- deleted`, `~ changed`. */
export function diffFiles(diff: string): string[] {
  const files: { path: string; kind: "+" | "-" | "~" }[] = [];
  for (const line of stripAnsi(diff).split("\n")) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (header) files.push({ path: header[2]!, kind: "~" });
    else if (files.length && line.startsWith("new file mode")) files.at(-1)!.kind = "+";
    else if (files.length && line.startsWith("deleted file mode")) files.at(-1)!.kind = "-";
  }
  return files.map((f) => `${f.kind} ${f.path}`);
}

export function codexCloudAdapter(config: CodexCloudConfig = {}): HarnessAdapter {
  const command = config.command ?? process.env.TOP_CODEX_PATH ?? "codex";
  const cli = () => findCli(command, "Codex", "TOP_CODEX_PATH", "Install the Codex CLI and sign in with ChatGPT: run `codex login`");
  const firstPollMs = config.firstPollMs ?? 15_000;
  const maxPollMs = config.maxPollMs ?? 5 * 60_000;
  const followForMs = config.followForMs ?? 12 * 60 * 60_000;
  const submitTimeoutMs = config.submitTimeoutMs ?? 2 * 60_000;
  const checkTimeoutMs = config.checkTimeoutMs ?? 60_000;
  // Every task's status checks and sends share these two: a dozen tasks don't run a dozen CLIs at once.
  const calls = limiter(2);
  const env = () => harnessEnv(process.env);

  const cloud = (path: string, args: readonly string[], more: { input?: string; timeoutMs?: number; detached?: boolean; skip?: () => boolean } = {}) =>
    inPrivateDir("codex-cloud", (cwd) =>
      runCli(path, ["cloud", ...args], {
        cwd,
        env: env(),
        input: more.input,
        timeoutMs: more.timeoutMs ?? checkTimeoutMs,
        detached: more.detached,
        skip: more.skip,
      }),
    );

  const check = async (): Promise<Availability> => {
    let path: string;
    try {
      path = await cli();
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    const version = await inPrivateDir("codex-cloud", (cwd) => runCli(path, ["--version"], { cwd, env: env(), timeoutMs: 10_000 }));
    if (version.code !== 0) return { ok: false, error: `\`${command} --version\` failed${version.spawnError ? `: ${version.spawnError}` : ""}.` };
    const help = await cloud(path, ["--help"], { timeoutMs: 10_000 });
    const execHelp = await cloud(path, ["exec", "--help"], { timeoutMs: 10_000 });
    const missing = [
      ...["exec", "status", "diff"].filter((sub) => !new RegExp(`^\\s+${sub}\\b`, "m").test(help.stdout)),
      ...["--env", "--branch", "--attempts"].filter((flag) => !execHelp.stdout.includes(flag)),
    ];
    if (missing.length)
      return {
        ok: false,
        error: `This Codex CLI (${said(version.stdout, 80)}) has no \`codex cloud\` with ${missing.join(", ")}. Update the Codex CLI and try again.`,
      };
    // Only what kind of sign-in it is leaves this function: an API key's sign-in prints the key, masked, which is never kept.
    const login = await inPrivateDir("codex-cloud", (cwd) => runCli(path, ["login", "status"], { cwd, env: env(), timeoutMs: 10_000 }));
    const out = `${login.stdout}\n${login.stderr}`;
    if (login.code === 0 && /Logged in using ChatGPT/.test(out)) return { ok: true, version: said(version.stdout, 80) };
    if (/API key/i.test(out))
      return {
        ok: false,
        error: "Codex is signed in with an API key, and Codex cloud needs a ChatGPT sign-in: run `codex login` and sign in with ChatGPT.",
      };
    return { ok: false, error: "Codex isn't signed in with ChatGPT, which Codex cloud needs: run `codex login` and sign in with ChatGPT." };
  };

  return {
    id: CODEX_CLOUD,
    label: "Codex cloud",
    where: "cloud",
    guidance:
      "Its `environment` is a Codex cloud environment id that the user gives you: they see theirs in the `codex cloud` picker, or as `environment_id` of earlier tasks in `codex cloud list --json`; Top doesn't list them. It works on `branch` of that environment's repository there. Top follows the task to its end; its changes are never applied anywhere: the result says how to review and apply them.",
    capabilities: {
      resume: false,
      fork: false,
      steer: false,
      queue: false,
      questions: false,
      images: false,
      fileChanges: true,
      usage: false,
      cancel: false,
      reconnect: false,
      durable: true,
      follow: true,
    },
    options: codexCloudOptions,
    check,
    locate: async (cwd, { options, model }) => {
      if (cwd !== undefined) throw new Error("Codex cloud takes no `cwd`: it works on `branch` of the environment's repository, in the cloud.");
      if (model !== undefined) throw new Error("Codex cloud picks its own model: `codex cloud exec` has no model to set. Leave out `model`.");
      return { cwd: `${String(options.environment)} @ ${String(options.branch)}` };
    },
    open: async (spec: OpenSpec, emit: (event: HarnessEvent) => void) => {
      const path = await cli();
      const environment = String(spec.options.environment ?? "");
      const branch = String(spec.options.branch ?? "");
      const attempts = typeof spec.options.attempts === "number" ? spec.options.attempts : 1;
      let closed = false;
      let timer: NodeJS.Timeout | undefined;
      let wake: (() => void) | undefined;
      const unsaved = new Set<(error?: Error) => void>();

      const end = (event: Omit<Extract<HarnessEvent, { type: "turn_ended" }>, "type">) => {
        if (!closed) emit({ type: "turn_ended", ...event });
      };
      const log = (text: string) => {
        if (!closed) emit({ type: "log", kind: "status", text });
      };
      /** Saves an id before going on: the marker that a send began has to be on disk before the send. */
      const save = (externalId: string) =>
        new Promise<void>((resolve, reject) => {
          if (closed) return reject(new Error("closed"));
          const saved = (error?: Error) => {
            unsaved.delete(saved);
            if (error) reject(error);
            else resolve();
          };
          unsaved.add(saved);
          emit({ type: "session", externalId, saved });
        });
      /** A CLI call in its turn. Closed by the time it would start (checked after its folder is made, just before the process): never started. One already running finishes. */
      const call = (args: readonly string[], more: { input?: string; timeoutMs?: number; detached?: boolean } = {}) =>
        calls(() => cloud(path, args, { ...more, skip: () => closed }));
      const sleep = (ms: number) =>
        new Promise<void>((resolve) => {
          wake = resolve;
          timer = setTimeout(resolve, ms);
        });

      const finished = async (id: string, status: Status) => {
        const url = codexTaskUrl(id);
        const diff = await call(["diff", id]);
        if (diff.skipped) return;
        const files = diff.code === 0 ? diffFiles(diff.stdout) : [];
        if (files.length && !closed) emit({ type: "log", kind: "file_change", text: files.slice(0, 200).join("\n") });
        if (diff.code !== 0) log(`couldn't read its diff: ${said(diff.stderr || diff.stdout, 300) || `exit ${diff.code}`}`);
        const applied =
          status.state === "APPLIED"
            ? "Its changes were already applied with `codex cloud apply`."
            : `Its changes aren't applied anywhere: see them with \`codex cloud diff ${id}\` and apply them with \`codex cloud apply ${id}\`.`;
        const tries =
          attempts > 1
            ? `\nIt was asked for ${attempts} attempts; this is attempt 1. See the others with \`codex cloud diff ${id} --attempt 2\` (up to ${attempts}).`
            : "";
        end({
          status: "completed",
          result: `Codex cloud finished: ${said(status.title, 300) || "(no title)"}\n${said(status.summary, 100) || "no diff"}\n${url}\n${applied}${tries}`,
        });
      };

      const follow = async (id: string) => {
        const url = codexTaskUrl(id);
        const since = Date.now();
        let wait = firstPollMs;
        let last = "";
        while (!closed) {
          const ran: Ran = await call(["status", id]);
          if (closed) return;
          // `status` exits 1 for everything but READY: what it printed says how it went, not its exit code.
          const status = parseCodexStatus(ran.stdout);
          const now = status
            ? `Codex cloud: ${status.state}`
            : `couldn't check it: ${said(ran.stderr || ran.stdout, 300) || ran.spawnError || `exit ${ran.code}`}`;
          if (now !== last) log(now);
          last = now;
          if (status?.state === "READY" || status?.state === "APPLIED") return finished(id, status);
          if (status?.state === "ERROR")
            return end({
              status: "failed",
              error: `Codex cloud reports an error for it (it failed there, or was cancelled there): ${said(status.title, 300) || "(no title)"}. See ${url}`,
            });
          if (Date.now() - since + wait > followForMs)
            return end({ status: "failed", error: `Top stopped following it after ${duration(followForMs)}; its status is unknown. See ${url}` });
          await sleep(wait);
          wait = Math.min(wait * 2, maxPollMs);
        }
      };

      const submit = async (turn: Turn) => {
        try {
          await save(`${PENDING}${turn.key}`);
        } catch (error) {
          if (!closed) end({ status: "failed", error: `It wasn't sent: ${error instanceof Error ? error.message : String(error)}` });
          return;
        }
        log(`sending it to Codex cloud (environment ${environment}, branch ${branch}${attempts > 1 ? `, ${attempts} attempts` : ""})`);
        // Its own process group, and not stopped when Top closes: a send halfway through finishes rather than leaving it unknown.
        const ran = await call(["exec", "--env", environment, "--branch", branch, "--attempts", String(attempts), "-"], {
          input: turn.text,
          timeoutMs: submitTimeoutMs,
          detached: true,
        });
        // Closed before its turn: nothing was sent. Only the marker is left, and after a restart it says "may or may not", never "sent".
        if (ran.skipped) return;
        // An id that `redact` would change is never kept: it would be saved, shown and followed as something else.
        const found = stripAnsi(ran.stdout)
          .split("\n")
          .map((line) => TASK_URL.exec(line.trim())?.[1])
          .find((id) => id !== undefined && redact(id) === id);
        if (found) {
          try {
            await save(found);
          } catch {
            // Saved or not, it's following it now; a restart before this saved says it may or may not have been sent.
          }
          log(`sent: ${codexTaskUrl(found)}`);
          return follow(found);
        }
        const why = said(ran.stderr || ran.stdout, 600) || ran.spawnError || (ran.timedOut ? "it didn't finish in time" : `exit ${ran.code}`);
        if (ran.spawnError || (!ran.timedOut && NOT_SENT.some((pattern) => pattern.test(stripAnsi(ran.stderr)))))
          return end({ status: "failed", error: `Codex cloud didn't take it: ${why}` });
        end({
          status: "failed",
          error: `It may or may not have reached Codex cloud (${ran.timedOut ? `\`codex cloud exec\` didn't finish within ${duration(submitTimeoutMs)}` : why}). Check \`codex cloud list\` before starting it again: Top never sends it twice.`,
        });
      };

      const guard = (work: Promise<void>) =>
        work.catch((error: unknown) =>
          end({ status: "failed", error: `Top failed while following it: ${error instanceof Error ? error.message : String(error)}` }),
        );

      return {
        run: async (turn) => {
          if (closed) throw new Error("closed");
          const known = spec.resume;
          if (known?.startsWith(PENDING))
            // Top restarted after it began sending this task and before it heard back.
            setTimeout(() =>
              end({
                status: "failed",
                error:
                  "Top restarted while it was sending this to Codex cloud, so it may or may not have got there. Check `codex cloud list` before starting it again: Top never sends it twice.",
              }),
            );
          else if (known) {
            log(`following ${codexTaskUrl(known)} again`);
            void guard(follow(known));
          } else if (turn.followOnly) setTimeout(() => end({ status: "interrupted" }));
          else void guard(submit(turn));
        },
        steer: refuse("Codex cloud", "take messages into a task"),
        interrupt: refuse("Codex cloud", "stop a task"),
        answer: () => {},
        close: async () => {
          closed = true;
          clearTimeout(timer);
          wake?.();
          for (const saved of unsaved) saved(new Error("closed"));
        },
      };
    },
  };
}
