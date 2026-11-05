/**
 * Tools, and what is safe to do with one that a daemon restart cut off.
 *
 * Every tool call is recorded before it runs. After a crash, a call without a result is settled by
 * the tool's policy, never by running it again blindly:
 *
 * - `replay: "safe"` (reads, checks): it runs again.
 * - `recover()`: the tool looks up its own outcome by `ctx.key` (for example an email provider's
 *   idempotency key) and reports what really happened.
 * - otherwise: the model is told it was interrupted and may have taken effect, and decides.
 *
 * `ctx.key` is stable for one call across restarts; pass it to outside services as an idempotency key.
 */
import { appendFileSync, readFileSync } from "node:fs";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";

export type ToolContext = {
  /** Stable for this one tool call, also across restarts. */
  readonly key: string;
  readonly bot: number;
  readonly signal?: AbortSignal;
};

export type ToolResult = AgentToolResult<unknown>;

export type TopTool = {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  /** JSON Schema of the arguments. */
  readonly parameters: object;
  readonly replay?: "never" | "safe";
  /** Normalizes raw arguments before schema validation (pi's tools accept older argument shapes). */
  readonly prepareArguments?: (args: unknown) => Record<string, unknown>;
  readonly executionMode?: "sequential" | "parallel";
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
  /** After a restart cut this call off: its result if it took effect, `false` if it surely did not, `undefined` if unknown. */
  recover?(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult | false | undefined>;
};

export const text = (value: string): ToolResult => ({ content: [{ type: "text", text: value }], details: {} });

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("Stopped"));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("Stopped"));
    }, { once: true });
  });
}

// ── fake tools with real side effects, for development and the crash tests ───────

/** Side effects of the fake tools, one JSON line each, so tests can count what really happened. */
export function createFakeTools(effectsPath: string): TopTool[] {
  const record = (tool: string, phase: string, key: string, detail?: unknown) =>
    appendFileSync(effectsPath, `${JSON.stringify({ tool, phase, key, detail, at: Date.now() })}\n`);
  const recorded = (tool: string, phase: string, key: string) => {
    try {
      return readFileSync(effectsPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .some((line) => {
          const e = JSON.parse(line) as { tool: string; phase: string; key: string };
          return e.tool === tool && e.phase === phase && e.key === key;
        });
    } catch {
      return false;
    }
  };
  const seconds = (args: Record<string, unknown>, fallback: number) => Math.max(0, Number(args.seconds ?? fallback)) * 1_000;
  const schema = (properties: Record<string, object>) => ({ type: "object", properties, additionalProperties: false });

  return [
    {
      // Takes effect at once, then takes a while to report. Cannot check its outcome: a restart in
      // between leaves it "interrupted, may have taken effect".
      name: "deploy",
      label: "Deploy",
      description: "Deploy a service. Takes effect immediately.",
      parameters: schema({ service: { type: "string" }, seconds: { type: "number" } }),
      async run(args, ctx) {
        record("deploy", "effect", ctx.key, args.service);
        await sleep(seconds(args, 2), ctx.signal);
        return text(`Deployed ${String(args.service ?? "the service")}.`);
      },
    },
    {
      // Sends, then waits for the provider's receipt. Its provider dedupes by key, so after a restart
      // it can look up whether the send happened.
      name: "send_email",
      label: "Send email",
      description: "Send an email.",
      parameters: schema({ to: { type: "string" }, subject: { type: "string" }, seconds: { type: "number" } }),
      async run(args, ctx) {
        if (!recorded("send_email", "effect", ctx.key)) record("send_email", "effect", ctx.key, args.to);
        await sleep(seconds(args, 2), ctx.signal);
        return text(`Sent “${String(args.subject ?? "")}” to ${String(args.to ?? "")}.`);
      },
      async recover(args, ctx) {
        return recorded("send_email", "effect", ctx.key) ? text(`Sent “${String(args.subject ?? "")}” to ${String(args.to ?? "")} (confirmed after a restart).`) : false;
      },
    },
    {
      // Read-only, so a restart just runs it again.
      name: "check_status",
      label: "Check status",
      description: "Check the status of a system. Read-only.",
      parameters: schema({ target: { type: "string" }, seconds: { type: "number" } }),
      replay: "safe",
      async run(args, ctx) {
        record("check_status", "start", ctx.key, args.target);
        await sleep(seconds(args, 1), ctx.signal);
        return text(`${String(args.target ?? "Everything")} is healthy. Queue depth 0, p99 41 ms.`);
      },
    },
    {
      // Kills the daemon every time it runs, to test that a crash loop ends.
      name: "crash_daemon",
      label: "Crash the daemon",
      description: "Testing only: kills the daemon process.",
      parameters: schema({}),
      replay: "safe",
      async run(_args, ctx) {
        record("crash_daemon", "start", ctx.key);
        process.kill(process.pid, "SIGKILL");
        await sleep(60_000);
        return text("unreachable");
      },
    },
  ];
}
