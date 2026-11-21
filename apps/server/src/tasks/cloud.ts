import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clip, redact } from "./harness.ts";

/** What a vendor CLI said, for a task's log or error: secrets out, colours out, bounded. */
export function said(text: string, max = 600): string {
  return clip(redact(stripAnsi(text)).trim(), max);
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes are what this strips.
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

/** Tests only: runs once a private folder is made, before what uses it, so a test can act in between. */
export const testHooks: { prepared?: ((dir: string) => Promise<void>) | undefined } = {};

/** A folder only the daemon's user can read, for a CLI to run in: never the user's checkout. Gone after `use`. */
export async function inPrivateDir<T>(prefix: string, use: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), `top-${prefix}-`));
  try {
    await testHooks.prepared?.(dir);
    return await use(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export type Ran = {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** It ran past its time and was stopped. */
  readonly timedOut: boolean;
  /** It couldn't be started at all, so it did nothing. */
  readonly spawnError?: string | undefined;
  /** Never started: its harness session had closed by the time its turn came. */
  readonly skipped?: true | undefined;
};

export const SKIPPED: Ran = { code: null, stdout: "", stderr: "", timedOut: false, skipped: true };

export type RunOptions = {
  readonly cwd: string;
  readonly env: Record<string, string | undefined>;
  /** Written to its stdin, which is then closed. Left out: stdin is closed from the start. */
  readonly input?: string | undefined;
  readonly timeoutMs: number;
  readonly onOutput?: ((stdout: string, stderr: string) => void) | undefined;
  /** Its own process group, so a signal meant for the daemon's (a Ctrl-C) doesn't stop it halfway through a send. */
  readonly detached?: boolean | undefined;
  /** Asked last, after all setup and just before the process starts: true leaves it unstarted (`skipped`). */
  readonly skip?: (() => boolean) | undefined;
  /** Aborted: it's stopped as at its time limit, but not counted as timed out. */
  readonly signal?: AbortSignal | undefined;
};

const MAX_OUTPUT = 1_000_000;

/** Runs a CLI to its end, or its time limit (then SIGTERM, SIGKILL after 5 s). Never throws. */
export function runCli(path: string, args: readonly string[], options: RunOptions): Promise<Ran> {
  if (options.skip?.()) return Promise.resolve(SKIPPED);
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const done = (ran: Ran) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(kill);
      options.signal?.removeEventListener("abort", aborted);
      resolve(ran);
    };
    let kill: NodeJS.Timeout | undefined;
    const child = spawn(path, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      detached: options.detached ?? false,
    });
    const stop = () => {
      if (kill) return;
      child.kill("SIGTERM");
      kill = setTimeout(() => child.kill("SIGKILL"), 5_000);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs);
    const aborted = () => stop();
    if (options.signal?.aborted) stop();
    else options.signal?.addEventListener("abort", aborted, { once: true });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length < MAX_OUTPUT) stdout += chunk;
      options.onOutput?.(stdout, stderr);
    });
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < MAX_OUTPUT) stderr += chunk;
      options.onOutput?.(stdout, stderr);
    });
    child.on("error", (error) => done({ code: null, stdout, stderr, timedOut, spawnError: error.message }));
    child.on("close", (code) => done({ code, stdout, stderr, timedOut }));
    if (options.input !== undefined && child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.end(options.input);
    }
  });
}

/** At most `max` at once, in the order asked: one adapter's polls and sends share it. */
export function limiter(max: number) {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async <T>(work: () => Promise<T>): Promise<T> => {
    if (running >= max) await new Promise<void>((go) => waiting.push(go));
    running++;
    try {
      return await work();
    } finally {
      running--;
      waiting.shift()?.();
    }
  };
}

/** A harness that runs in the cloud has no live turn to steer or stop here: these say so, never pretending. */
export const refuse = (label: string, what: string) => () => Promise.reject(new Error(`${label} can't ${what}.`));
