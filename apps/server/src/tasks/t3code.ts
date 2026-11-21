import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import Type from "typebox";
import { runCli, said, stripAnsi } from "./cloud.ts";
import { type Availability, findCli, type HarnessAdapter, type HarnessEvent, HarnessUnavailable, harnessEnv, type OpenSpec, type Turn } from "./harness.ts";

/**
 * T3 Code on this computer, through its own `t3` CLI. `t3 thread start <folder> - --wait` starts a thread in the T3 Code project
 * that holds the folder and `t3 thread send <thread> - --wait` gives it the next message; both wait for the run to end the
 * way T3 Code itself decides (its `t3_thread_wait`, through a restart of T3 Code and the work the run handed off), then
 * print the reply. Exit 1 is a run that didn't complete, 2 one that waits for an answer in T3 Code.
 *
 * Stop and steer aren't in the CLI: for those Top asks the CLI for a short-lived session (`t3 auth session issue`, which
 * only the machine's own user can do), sends one command over T3 Code's app socket, and revokes the session at once.
 * Questions, secrets and approvals stay in T3 Code.
 */
export const T3CODE = "t3code";

/** The orchestration protocol of the one command Top sends over T3 Code's socket; T3 Code refuses a socket for another. */
const T3_PROTOCOL = 2;
/** The longest a timer can wait: a run's wait has no limit of its own. */
const FOREVER_MS = 2_147_483_647;
/** How long a stop waits for T3 Code to have a message Top just sent, inside the coordinator's bound on sending a stop. */
const LAND_MS = 15_000;
const INSTALL = "Install T3 Code (t3.codes) and keep it running";

export const t3codeOptions = Type.Object(
  {
    provider: Type.Optional(
      Type.String({
        description: "The T3 Code provider instance that runs it, such as claudeAgent or codex. Give it with `model`. Default: the project's own.",
      }),
    ),
  },
  { additionalProperties: false },
);

export type T3CodeConfig = {
  readonly command?: string | undefined;
  /** T3 Code's data folder (default: T3CODE_HOME, else ~/.t3). */
  readonly home?: string | undefined;
  readonly commandTimeoutMs?: number | undefined;
};

type Rec = Record<string, unknown>;
const record = (value: unknown): Rec => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Rec) : {});
const str = (value: unknown) => (typeof value === "string" && value ? value : undefined);
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function jsonOf(stdout: string): Rec | undefined {
  try {
    const value = JSON.parse(stripAnsi(stdout).trim()) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Rec) : undefined;
  } catch {
    return undefined;
  }
}

/** What the CLI said when it stopped short, or how it ended. */
function why(ran: { stdout: string; stderr: string; code: number | null; spawnError?: string | undefined; timedOut: boolean }): string {
  return said(ran.stderr, 600) || ran.spawnError || (ran.timedOut ? "it didn't finish in time" : `exit ${ran.code}`);
}

/** Where the running T3 Code server listens, from the state it keeps in its data folder; undefined when none runs there. */
async function runtimeOf(home: string): Promise<{ readonly origin: string; readonly serverVersion: string | undefined } | undefined> {
  let raw: Rec;
  try {
    raw = record(JSON.parse(await readFile(join(home, "userdata", "server-runtime.json"), "utf8")));
  } catch {
    return undefined;
  }
  const origin = str(raw.origin);
  return origin ? { origin, serverVersion: str(raw.serverVersion) } : undefined;
}

export function t3codeAdapter(config: T3CodeConfig = {}): HarnessAdapter {
  const home = config.home ?? process.env.T3CODE_HOME ?? join(homedir(), ".t3");
  const commandTimeoutMs = config.commandTimeoutMs ?? 60_000;
  const env = () => ({ ...harnessEnv(process.env), T3CODE_HOME: home });
  const notRunning = `T3 Code isn't running on this computer (no server uses ${home}). Start T3 Code and try again.`;

  /** The `t3` the user pointed at, else the running server's own version of it (the CLI then always matches the server), else one on PATH. */
  const cli = async (): Promise<string> => {
    const given = config.command ?? process.env.TOP_T3_PATH;
    if (given) return findCli(given, "T3 Code's CLI", "TOP_T3_PATH", INSTALL);
    const version = (await runtimeOf(home))?.serverVersion;
    if (version && /^[\w.+-]+$/.test(version) && !version.startsWith("."))
      try {
        return await findCli(join(home, "runtime", "versions", version, "t3"), "T3 Code's CLI", "TOP_T3_PATH", INSTALL);
      } catch {}
    return findCli("t3", "T3 Code's CLI", "TOP_T3_PATH", INSTALL);
  };
  const t3 = async (args: string[], cwd: string, timeoutMs = commandTimeoutMs) => runCli(await cli(), args, { cwd, env: env(), timeoutMs });

  /** The server answering at `origin` is T3 Code, speaking the protocol of the command Top sends. */
  const described = async (origin: string) => {
    let body: Rec;
    try {
      const response = await fetch(`${origin}/.well-known/t3/environment`, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
      body = record(await response.json());
    } catch (error) {
      throw new HarnessUnavailable(`${notRunning} (${origin}: ${message(error)})`);
    }
    const protocol = body.orchestrationProtocolVersion;
    if (protocol !== T3_PROTOCOL)
      throw new Error(
        `T3 Code ${str(body.serverVersion) ?? ""} speaks orchestration protocol ${typeof protocol === "number" ? protocol : "unknown"}, and Top's stop and steer speak ${T3_PROTOCOL}. ${
          typeof protocol === "number" && protocol < T3_PROTOCOL ? "Update T3 Code." : "Update Top."
        }`,
      );
    return { version: str(body.serverVersion) ?? "" };
  };

  /**
   * One command on T3 Code's app socket, under a session made for it and revoked straight after: the credential lives
   * only in this call and never reaches a log, the bot or the disk.
   */
  const dispatch = async (command: Rec): Promise<void> => {
    const runtime = await runtimeOf(home);
    if (!runtime) throw new Error(notRunning);
    await described(runtime.origin);
    const issued = await t3(["auth", "session", "issue", "--scope", "orchestration:operate", "--ttl", "5m", "--label", "Top", "--json"], tmpdir());
    // Its stdout carries the credential: only stderr is ever quoted.
    const session = issued.code === 0 ? jsonOf(issued.stdout) : undefined;
    const sessionId = str(session?.sessionId);
    const token = str(session?.token);
    if (!sessionId || !token) throw new Error(`T3 Code didn't give Top a session: ${said(issued.stderr, 400) || issued.spawnError || `exit ${issued.code}`}`);
    try {
      const response = await fetch(`${runtime.origin}/api/auth/websocket-ticket/rpc`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
      const ticket = str(record(await response.json().catch(() => undefined)).ticket);
      if (!response.ok || !ticket) throw new Error(`T3 Code didn't open its socket to Top (HTTP ${response.status}).`);
      const url = new URL("/ws", runtime.origin.replace(/^http/, "ws"));
      url.searchParams.set("orchestrationProtocol", String(T3_PROTOCOL));
      url.searchParams.set("wsTicket", ticket);
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(url);
        let settled = false;
        const done = (error?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try {
            ws.close();
          } catch {}
          if (error) reject(error);
          else resolve();
        };
        const timer = setTimeout(() => done(new Error("T3 Code didn't answer in time.")), commandTimeoutMs);
        ws.addEventListener("open", () =>
          ws.send(JSON.stringify({ _tag: "Request", id: "1", tag: "orchestration.dispatchCommand", payload: command, headers: [] })),
        );
        ws.addEventListener("message", (event) => {
          let frame: Rec;
          try {
            frame = record(JSON.parse(String(event.data)));
          } catch {
            return;
          }
          if (frame._tag !== "Exit" || String(frame.requestId) !== "1") return;
          const exit = record(frame.exit);
          if (exit._tag === "Success") return done();
          const cause = (Array.isArray(exit.cause) ? exit.cause : []).map(record).find((c) => c._tag === "Fail" || c._tag === "Die");
          const failure = record(cause?.error);
          done(new Error(`T3 Code refused it: ${said(str(failure.message) ?? str(failure._tag) ?? JSON.stringify(cause?.defect ?? exit), 400)}`));
        });
        ws.addEventListener("error", () => done(new Error("T3 Code's socket failed.")));
        ws.addEventListener("close", () => done(new Error("T3 Code closed its socket before it answered.")));
      });
    } finally {
      await t3(["auth", "session", "revoke", sessionId], tmpdir()).catch(() => {});
    }
  };

  const check = async (): Promise<Availability> => {
    try {
      const path = await cli();
      const help = await runCli(path, ["thread", "start", "--help"], { cwd: tmpdir(), env: env(), timeoutMs: 15_000 });
      if (!/--wait\b/.test(help.stdout))
        return { ok: false, error: `This T3 Code CLI (${path}) can't wait for a thread's run (no \`t3 thread start --wait\`). Update T3 Code.` };
      const runtime = await runtimeOf(home);
      if (!runtime) return { ok: false, error: notRunning };
      return { ok: true, version: (await described(runtime.origin)).version };
    } catch (error) {
      return { ok: false, error: message(error) };
    }
  };

  return {
    id: T3CODE,
    label: "T3 Code",
    guidance:
      "Runs as a thread in the T3 Code on this computer: `cwd` has to be inside one of its projects. The task ends when T3 Code says the run has ended, with its reply. When T3 Code waits for an answer, the task is handed off with the thread's link: the user answers it in T3 Code. `model` goes with `provider`.",
    capabilities: {
      resume: true,
      fork: false,
      steer: true,
      queue: true,
      questions: false,
      images: false,
      fileChanges: false,
      usage: false,
      cancel: true,
      reconnect: true,
      durable: false,
    },
    outlives: true,
    options: t3codeOptions,
    check,
    open: async (spec: OpenSpec, emit: (event: HarnessEvent) => void) => {
      const provider = str(spec.options.provider);
      if (!spec.resume && !provider !== !spec.model)
        throw new HarnessUnavailable("T3 Code takes `model` together with `provider` (a T3 Code provider instance, such as claudeAgent or codex).");
      const path = await cli();
      let thread = spec.resume;
      if (thread) emit({ type: "session", externalId: thread });
      let closed = false;
      let running: AbortController | undefined;
      let stopWanted = false;
      /** T3 Code has the running turn: its thread was just made, or a sent message shows as its active run. */
      let landed = false;
      let stopping: Promise<void> | undefined;

      const end = (event: Omit<Extract<HarnessEvent, { type: "turn_ended" }>, "type">) => {
        if (!closed) emit({ type: "turn_ended", ...event });
      };
      const link = async (id: string) => {
        const shown = await t3(["thread", "show", id, "--json", "--messages", "0"], spec.cwd).catch(() => undefined);
        return str(record(jsonOf(shown?.stdout ?? "")?.thread).link) ?? `thread ${id}`;
      };
      /** T3 Code's own Stop on the task's thread: its run, its queue and the work it delegated. */
      const stop = (id: string) =>
        (stopping ??= dispatch({ type: "thread.stop", commandId: `top:stop:${randomUUID()}`, threadId: id, reason: "Cancelled in Top." })
          .catch((error: unknown) => emit({ type: "log", kind: "error", text: `T3 Code didn't take the stop: ${message(error)}` }))
          .finally(() => {
            stopping = undefined;
          }));

      const go = async (turn: Turn) => {
        const abort = new AbortController();
        running = abort;
        stopWanted = false;
        landed = false;
        const starting = !thread;
        const args = starting
          ? ["thread", "start", spec.cwd, "-", "--wait", ...(provider && spec.model ? ["--provider", provider, "--model", spec.model] : [])]
          : ["thread", "send", thread!, "-", "--wait"];
        const ran = await runCli(path, args, {
          cwd: spec.cwd,
          env: env(),
          input: turn.text,
          timeoutMs: FOREVER_MS,
          signal: abort.signal,
          onOutput: (_stdout, stderr) => {
            if (thread) return;
            // The first thing `start --wait` says, on stderr, once T3 Code has made the thread.
            const id = /^Thread (\S+)$/m.exec(stripAnsi(stderr))?.[1];
            if (!id) return;
            thread = id;
            landed = true;
            emit({ type: "session", externalId: id, ...(spec.model ? { model: spec.model } : {}) });
            if (stopWanted) void stop(id);
          },
        });
        if (running === abort) running = undefined;
        if (closed) return;
        if (ran.code === 0) return end({ status: "completed", result: stripAnsi(ran.stdout).trim() });
        if (ran.code === 2 && thread)
          return end({
            status: "handed_off",
            result: `T3 Code is waiting for an answer in ${await link(thread)}. The user answers it there; Top doesn't see how the run ends.`,
          });
        const stopped = /stopped with status (\w+)(?::\s*([\s\S]*))?/.exec(stripAnsi(ran.stderr));
        if (stopped && (stopped[1] === "interrupted" || stopped[1] === "cancelled"))
          return end({ status: "interrupted", error: stopWanted ? "Stopped." : "The run was stopped in T3 Code." });
        if (stopped) return end({ status: "failed", error: `T3 Code's run ended as ${stopped[1]}${stopped[2] ? `: ${said(stopped[2], 600)}` : "."}` });
        if (starting && !thread) return end({ status: "failed", error: `T3 Code didn't start the thread: ${why(ran)}` });
        end({ status: "failed", error: `Top lost the wait on T3 Code's thread ${thread} (${why(ran)}); it may still be running there.` });
      };

      return {
        run: async (turn) => {
          if (closed) throw new Error("closed");
          if (turn.images.length) throw new Error("Top doesn't send images to T3 Code.");
          void go(turn).catch((error: unknown) => end({ status: "failed", error: `Top failed while waiting on T3 Code: ${message(error)}` }));
        },
        steer: async (text) => {
          if (!running || !thread) throw new Error("T3 Code has no run of this task going to steer yet.");
          const shown = await t3(["thread", "show", thread, "--json", "--messages", "0"], spec.cwd);
          const runId = str(record(jsonOf(shown.stdout)?.thread).activeRunId);
          if (!runId)
            throw new Error(shown.code === 0 ? "T3 Code has no run going in this task's thread to steer." : `T3 Code didn't show the thread: ${why(shown)}`);
          const id = `top:steer:${randomUUID()}`;
          await dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: id,
            threadId: thread,
            messageId: id,
            text,
            attachments: [],
            dispatchMode: { type: "steer_active", targetRunId: runId },
          });
        },
        interrupt: async () => {
          if (!running) return;
          const wait = running;
          stopWanted = true;
          // Not started yet: the stop goes out as soon as T3 Code names the thread.
          if (!thread) return;
          // A message still on its way would start its run after a Stop on the idle thread: wait until T3 Code has it.
          for (const until = Date.now() + LAND_MS; !landed && running === wait && Date.now() < until; ) {
            const shown = await t3(["thread", "show", thread, "--json", "--messages", "0"], spec.cwd, Math.max(1, until - Date.now())).catch(() => undefined);
            if (str(record(jsonOf(shown?.stdout ?? "")?.thread).activeRunId)) landed = true;
            else await new Promise((resolve) => setTimeout(resolve, 250));
          }
          if (running === wait) await stop(thread);
        },
        answer: () => {},
        close: async () => {
          closed = true;
          // Only the wait ends: a run still going in T3 Code carries on there.
          running?.abort();
        },
      };
    },
  };
}
