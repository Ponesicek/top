import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "vitest";
import { botFolder } from "../src/workspace.ts";

// TOP_REAL_CLAUDE_BOT=1 runs a Claude bot on the real Agent SDK and the Claude Code CLI installed here, signed in as
// it is (a Claude subscription; Top refuses API keys), on Haiku with short harmless prompts. It kills the daemon with
// SIGKILL while a tool runs and starts it again.
const real = process.env.TOP_REAL_CLAUDE_BOT === "1";

type Line = Record<string, unknown> & { entries?: { kind: string; outcome?: string; message: Record<string, unknown> }[] };

function daemon(dir: string, phase: "first" | "resume", messages: string[]) {
  const child = spawn(process.execPath, ["--import", "tsx", join(import.meta.dirname, "fixtures", "claude-bot-daemon.ts"), dir, phase, ...messages], {
    stdio: ["ignore", "pipe", "inherit"],
    env: { ...process.env, TOP_TEST_USER_MD: "The user's favourite colour is teal." },
  });
  const lines: Line[] = [];
  const waiters: (() => void)[] = [];
  createInterface({ input: child.stdout! }).on("line", (line) => {
    try {
      lines.push(JSON.parse(line) as Line);
    } catch {
      return;
    }
    for (const wake of waiters.splice(0)) wake();
  });
  const next = async (what: (line: Line) => boolean, timeoutMs = 240_000) => {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const found = lines.find(what);
      if (found) return found;
      if (lines.some((l) => l.error)) throw new Error(String(lines.find((l) => l.error)!.error));
      if (Date.now() > end) throw new Error("timed out");
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
        setTimeout(resolve, 1_000);
      });
    }
  };
  return { child, lines, next };
}

const exited = (child: ChildProcess) => new Promise((resolve) => (child.exitCode !== null ? resolve(undefined) : child.once("exit", resolve)));
const textOf = (message: Record<string, unknown>) =>
  Array.isArray(message.content)
    ? message.content.map((p: { type: string; text?: string }) => (p.type === "text" ? (p.text ?? "") : "")).join("")
    : String(message.content);

/** Claude Code processes working in this folder. */
function claudeIn(folder: string): number[] {
  const pids = execFileSync("pgrep", ["-x", "claude"], { encoding: "utf8" }).split("\n").filter(Boolean).map(Number);
  return pids.filter((pid) => {
    try {
      return readlinkSync(`/proc/${pid}/cwd`) === folder;
    } catch {
      return false;
    }
  });
}

test.skipIf(!real)(
  "a real Claude bot: answers with its files, calls Top's tools over MCP, dies with a killed daemon, and after the restart its cut-off tool never runs again",
  { timeout: 900_000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "top-real-claude-"));
    const folder = botFolder(join(dir, "bots"), "Quill");

    const first = daemon(dir, "first", [
      "What is my favourite colour? Reply with one word.",
      'Call the echo tool with the text "zebra", then reply with exactly what it returned.',
      "Use your Bash tool to run exactly: echo built-in-ok > proof.txt && cat proof.txt. Then reply with only what it printed.",
      'Deploy to "staging" with the deploy tool. Call deploy once only; never call it again for this request, whatever happens. Then reply DONE.',
    ]);
    await first.next((l) => l.started === true);
    const colour = await first.next((l) => l.idle === true);
    const answer = colour.entries!.filter((e) => e.kind === "assistant").at(-1)!;
    assert.match(textOf(answer.message), /teal/i, "USER.md reached Claude through Top's system prompt");
    const echoed = await first.next((l) => l.idle === true && l !== colour);
    const tool = echoed.entries!.find((e) => e.kind === "tool");
    assert.ok(tool, "the echo call ran through Top");
    assert.equal(textOf(tool.message), "arbez");
    assert.match(textOf(echoed.entries!.filter((e) => e.kind === "assistant").at(-1)!.message), /arbez/);
    const bashed = await first.next((l) => l.idle === true && l !== colour && l !== echoed);
    const bash = bashed.entries!.filter((e) => e.kind === "tool").at(-1)!;
    assert.equal((bash.message as { toolName?: string }).toolName, "Bash", "Claude Code's own Bash ran, recorded by Top");
    assert.match(textOf(bash.message), /built-in-ok/);
    assert.equal(readFileSync(join(folder, "proof.txt"), "utf8").trim(), "built-in-ok", "in the bot's folder");

    await first.next((l) => l.deployStarted === "staging");
    const working = claudeIn(folder);
    assert.ok(working.length > 0, "Claude Code runs in the bot's folder");
    first.child.kill("SIGKILL");
    await exited(first.child);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    assert.deepEqual(claudeIn(folder), [], "Claude Code died with the daemon instead of carrying on the turn without it");

    const again = daemon(dir, "resume", []);
    const started = await again.next((l) => l.started === true);
    assert.equal(started.session, colour.session, "the session carries on");
    const settled = await again.next((l) => l.idle === true);
    await exited(again.child);
    assert.equal(settled.deployRuns, 1, "deploy ran once, before the kill, and never again");
    // After the restart Claude may check or ask before anything else, so the deploy's own result is the one to look at.
    const deployResult = settled.entries!.find((e) => e.kind === "tool" && (e.message as { toolName?: string }).toolName === "deploy")!;
    assert.equal(deployResult.outcome, "interrupted");
    const final = settled.entries!.filter((e) => e.kind === "assistant").at(-1)!;
    assert.ok(textOf(final.message).trim(), "Claude answered after the restart");

    const sessionFile = readdirSync(join(process.env.HOME!, ".claude", "projects"))
      .map((d) => join(process.env.HOME!, ".claude", "projects", d, `${String(settled.session)}.jsonl`))
      .find((path) => {
        try {
          readFileSync(path);
          return true;
        } catch {
          return false;
        }
      });
    assert.ok(sessionFile, "Claude Code kept the session");
    assert.match(readFileSync(sessionFile, "utf8"), /this is what Top recorded/, "Claude was told what Top recorded for the cut-off call");
    process.stdout.write(`real Claude bot: final answer ${JSON.stringify(textOf(final.message))}; status ${JSON.stringify(settled.status)}\n`);
  },
);
