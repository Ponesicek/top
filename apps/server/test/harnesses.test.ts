import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative as relativePath } from "node:path";
import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, test } from "vitest";
import { claudeAdapter, type QueryFn } from "../src/tasks/claude.ts";
import { codexAdapter } from "../src/tasks/codex.ts";
import { findCli, type HarnessEvent, HarnessUnavailable, harnessEnv, type OpenSpec, redact } from "../src/tasks/harness.ts";
import { until } from "./harness.ts";

const FAKE_CODEX = join(import.meta.dirname, "fixtures", "fake-codex.mjs");

const spec = (over: Partial<OpenSpec> = {}): OpenSpec => ({
  session: "ses_test",
  title: "Test task",
  cwd: mkdtempSync(join(tmpdir(), "top-harness-")),
  model: undefined,
  options: {},
  resume: undefined,
  fork: false,
  ...over,
});

const collect = () => {
  const events: HarnessEvent[] = [];
  return {
    events,
    emit: (event: HarnessEvent) => events.push(event),
    of: <T extends HarnessEvent["type"]>(type: T) => events.filter((e): e is Extract<HarnessEvent, { type: T }> => e.type === type),
  };
};

afterEach(() => {
  delete process.env.FAKE_CODEX_LOG;
  delete process.env.FAKE_CODEX_LOGGED_OUT;
});

const codexLog = (path: string) =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown>; result?: Record<string, unknown> });

test("Codex: a thread runs with full access and approvals off, and the turn's answer is the result", async () => {
  const log = join(mkdtempSync(join(tmpdir(), "top-codex-")), "log.jsonl");
  process.env.FAKE_CODEX_LOG = log;
  const codex = codexAdapter({ command: FAKE_CODEX });
  assert.deepEqual(await codex.check(), { ok: true, version: "codex-cli 0.0.0-fake" });
  const c = collect();
  const where = spec();
  const session = await codex.open(where, c.emit);
  assert.deepEqual(c.of("session"), [{ type: "session", externalId: "thr_fake", model: "gpt-fake" }]);
  await session.run({ key: "k", text: "say hi", images: [] });
  const ended = await until("the turn to end", () => c.of("turn_ended")[0]);
  assert.deepEqual(ended, { type: "turn_ended", status: "completed", result: "hello: say hi" });
  assert.ok(c.of("log").some((e) => e.kind === "file_change" && e.text === "~ a.ts"));
  assert.deepEqual(c.of("usage").at(-1)!.usage, { inputTokens: 1200, outputTokens: 34, cachedInputTokens: 1000 });

  const sent = codexLog(log);
  const init = sent.find((m) => m.method === "initialize")!.params!;
  assert.equal((init.capabilities as { experimentalApi: boolean }).experimentalApi, false, "only the stable API");
  assert.ok(
    (init.capabilities as { optOutNotificationMethods: string[] }).optOutNotificationMethods.includes("item/agentMessage/delta"),
    "no token-by-token traffic",
  );
  assert.deepEqual(sent.find((m) => m.method === "thread/start")!.params, { cwd: where.cwd, approvalPolicy: "never", sandbox: "danger-full-access" });
  const turn = sent.find((m) => m.method === "turn/start")!.params!;
  assert.deepEqual([turn.sandboxPolicy, turn.approvalPolicy], [{ type: "dangerFullAccess" }, "never"]);
  assert.ok(!sent.some((m) => m.method?.startsWith("account/login")), "it never signs in or out");
  await session.close();
});

test("Codex: an approval or question it asks anyway is declined and logged, never left waiting; steering names the turn, and interrupt ends it", async () => {
  const log = join(mkdtempSync(join(tmpdir(), "top-codex-")), "log.jsonl");
  process.env.FAKE_CODEX_LOG = log;
  const codex = codexAdapter({ command: FAKE_CODEX });
  assert.equal(codex.capabilities.questions, false, "Codex's default mode doesn't ask questions");
  const c = collect();
  const session = await codex.open(spec({ resume: "thr_old" }), c.emit);
  assert.equal(c.of("session")[0]!.externalId, "thr_old");
  const resume = codexLog(log).find((m) => m.method === "thread/resume")!.params!;
  assert.deepEqual([resume.threadId, resume.approvalPolicy, resume.sandbox, resume.excludeTurns], ["thr_old", "never", "danger-full-access", true]);

  await session.run({ key: "k", text: "approve this", images: [] });
  assert.equal((await until("the turn to end", () => c.of("turn_ended")[0])).result, "decision: decline");
  assert.ok(c.of("log").some((e) => e.kind === "error" && /asked to run a command although Top runs it with approvals off; Top declined it/.test(e.text)));
  await session.run({ key: "k", text: "a question", images: [] });
  assert.equal((await until("the second turn", () => c.of("turn_ended")[1])).result, "answer: {}");
  assert.deepEqual(c.of("request"), [], "nothing is put on a card");

  await session.run({ key: "k", text: "wait for me", images: ["/tmp/x.png"] });
  await session.steer("go faster");
  const steer = await until("the steer", () => codexLog(log).find((m) => m.method === "turn/steer"));
  assert.equal((steer.params as { expectedTurnId: string }).expectedTurnId, "turn_3");
  const start = codexLog(log)
    .filter((m) => m.method === "turn/start")
    .at(-1)!;
  assert.deepEqual((start.params as { input: unknown[] }).input[1], { type: "localImage", path: "/tmp/x.png" });
  await session.interrupt();
  assert.equal((await until("the interrupt", () => c.of("turn_ended")[2])).status, "interrupted");
  await session.close();
});

test("Codex: not signed in, or not installed, says what to do", async () => {
  process.env.FAKE_CODEX_LOGGED_OUT = "1";
  const codex = codexAdapter({ command: FAKE_CODEX });
  await assert.rejects(
    codex.open(spec(), () => {}),
    (error: unknown) => error instanceof HarnessUnavailable && /Run `codex login`/.test(error.message),
  );
  const missing = await codexAdapter({ command: "definitely-not-codex-xyz" }).check();
  assert.match(!missing.ok ? missing.error : "", /Codex isn't installed on the daemon's computer.*TOP_CODEX_PATH/);
  const wrong = await codexAdapter({ command: "/nonexistent/codex" }).check();
  assert.match(!wrong.ok ? wrong.error : "", /Codex isn't at `\/nonexistent\/codex`.*TOP_CODEX_PATH/);
});

test("Claude Code and Codex installed in ~/.local/bin are found when the daemon's PATH leaves that folder out", async () => {
  const saved = { PATH: process.env.PATH, HOME: process.env.HOME };
  const home = mkdtempSync(join(tmpdir(), "top-home-"));
  const bin = join(home, ".local", "bin");
  mkdirSync(bin, { recursive: true });
  const script = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  script("claude", `case "$1" in --version) echo "2.1.329 (Claude Code)";; auth) echo '{"loggedIn":true}';; esac`);
  script("codex", `exec "${process.execPath}" "${FAKE_CODEX}" "$@"`);
  // What systemd gives a user service: no ~/.local/bin.
  process.env.PATH = "/usr/bin:/bin";
  process.env.HOME = home;
  try {
    assert.deepEqual(await claudeAdapter({ command: "claude" }).check(), { ok: true, version: "2.1.329 (Claude Code)" });
    const fake = fakeClaude(async () => [result("ok")]);
    const session = await claudeAdapter({ command: "claude", query: fake.query }).open(spec(), () => {});
    await session.close();
    assert.equal(fake.runs[0]!.options.pathToClaudeCodeExecutable, join(bin, "claude"));

    const codex = codexAdapter({ command: "codex" });
    assert.equal((await codex.check()).ok, true);
    const c = collect();
    const thread = await codex.open(spec(), c.emit);
    assert.equal(c.of("session").length, 1);
    await thread.close();

    // A folder of the same name isn't a program, and an override that points at nothing says so.
    mkdirSync(join(home, "dir", "claude"), { recursive: true });
    process.env.PATH = join(home, "dir");
    assert.deepEqual(await claudeAdapter({ command: "claude" }).check(), { ok: true, version: "2.1.329 (Claude Code)" });
    const notExecutable = join(home, "claude.txt");
    writeFileSync(notExecutable, "");
    const wrong = await claudeAdapter({ command: notExecutable }).check();
    assert.match(!wrong.ok ? wrong.error : "", /Claude Code isn't at .*claude\.txt.*TOP_CLAUDE_PATH/);
    // A relative override names the file next to the daemon, not one in the task's folder.
    const relative = relativePath(process.cwd(), join(bin, "codex"));
    assert.equal(await findCli(relative, "Codex", "TOP_CODEX_PATH", "Install it"), `${process.cwd()}/${relative}`);
  } finally {
    process.env.PATH = saved.PATH;
    process.env.HOME = saved.HOME;
  }
});

type FakeQuery = { messages: SDKUserMessage[]; options: Options; interrupted: number };

function fakeClaude(script: (message: SDKUserMessage, options: Options) => Promise<SDKMessage[]>) {
  const runs: FakeQuery[] = [];
  const query: QueryFn = ({ prompt, options }) => {
    const run: FakeQuery = { messages: [], options, interrupted: 0 };
    runs.push(run);
    const iterator = (async function* () {
      let first = true;
      for await (const message of prompt) {
        run.messages.push(message);
        if (first) {
          first = false;
          yield { type: "system", subtype: "init", session_id: options.sessionId ?? options.resume, model: "claude-test" } as unknown as SDKMessage;
        }
        for (const out of await script(message, options)) yield out;
      }
    })();
    return Object.assign(iterator, {
      interrupt: async () => {
        run.interrupted++;
        return undefined;
      },
      close: () => {},
    }) as unknown as ReturnType<QueryFn>;
  };
  return { runs, query };
}

const result = (text: string): SDKMessage =>
  ({
    type: "result",
    subtype: "success",
    is_error: false,
    result: text,
    usage: { input_tokens: 10, output_tokens: 2 },
    total_cost_usd: 0.01,
    session_id: "s",
  }) as unknown as SDKMessage;

const textOf = (message: SDKUserMessage) => (typeof message.message.content === "string" ? message.message.content : JSON.stringify(message.message.content));

test("Claude Code: runs with permission checks off, declines an unexpected approval at once, and answers questions by their text", async () => {
  const decisions: unknown[] = [];
  const fake = fakeClaude(async (message, options) => {
    const text = textOf(message);
    if (text.includes("approve")) {
      decisions.push(
        await options.canUseTool!("Bash", { command: "rm -rf /tmp/x" }, { signal: new AbortController().signal, toolUseID: "tu1", requestId: "r1" } as never),
      );
      return [result("ran")];
    }
    if (text.includes("ask")) {
      const answer = await options.canUseTool!(
        "AskUserQuestion",
        {
          questions: [
            {
              question: "Which colour?",
              header: "Colour",
              options: [
                { label: "red", description: "" },
                { label: "blue", description: "" },
              ],
              multiSelect: true,
            },
          ],
        },
        { signal: new AbortController().signal, toolUseID: "tu2", requestId: "r2" } as never,
      );
      decisions.push(answer);
      return [result("asked")];
    }
    return [
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Edit", input: { file_path: "/w/a.ts" } },
            { type: "text", text: "Edited." },
          ],
        },
        parent_tool_use_id: null,
      } as unknown as SDKMessage,
      result(`hi: ${text}`),
    ];
  });
  const claude = claudeAdapter({ command: "/bin/true", query: fake.query });
  const c = collect();
  const session = await claude.open(spec(), c.emit);
  const options = fake.runs[0]!.options;
  assert.equal(options.permissionMode, "bypassPermissions");
  assert.equal(options.allowDangerouslySkipPermissions, true);
  assert.deepEqual(options.sandbox, { enabled: false }, "a sandbox from Claude Code's settings doesn't apply either");
  assert.equal(options.settingSources, undefined, "Claude Code's own settings and CLAUDE.md load as they do for the user");
  assert.equal(options.pathToClaudeCodeExecutable, "/bin/true", "it drives the user's own Claude Code");
  assert.deepEqual(options.systemPrompt, { type: "preset", preset: "claude_code" });
  assert.match(String(options.sessionId), /^[0-9a-f-]{36}$/, "a new session has its id before anything runs");
  assert.deepEqual(c.of("session"), [], "no session is claimed before Claude Code confirms it");

  await session.run({ key: "k", text: "hello", images: [] });
  await until("the session", () => c.of("session")[0]);
  assert.equal(c.of("session")[0]!.externalId, options.sessionId);
  assert.equal((await until("the turn", () => c.of("turn_ended")[0])).result, "hi: hello");
  assert.ok(c.of("log").some((e) => e.kind === "file_change" && e.text === "~ /w/a.ts"));
  assert.equal(c.of("usage").at(-1)!.usage.costUsd, 0.01);

  await session.run({ key: "k", text: "approve", images: [] });
  await until("the second turn", () => c.of("turn_ended")[1]);
  assert.equal((decisions[0] as { behavior: string }).behavior, "deny");
  assert.ok(c.of("log").some((e) => e.kind === "error" && /asked to allow Bash although permission checks are off; Top declined it/.test(e.text)));
  assert.deepEqual(c.of("request"), [], "no approval card");

  await session.run({ key: "k", text: "ask me", images: [] });
  const question = await until("the question", () => c.of("request")[0]?.request);
  assert.deepEqual(question.questions, [
    { id: "q1", question: "Which colour?", header: "Colour", options: [{ label: "red" }, { label: "blue" }], multiple: true },
  ]);
  session.answer(question.id, { kind: "question", answers: { q1: ["red", "blue"] } });
  await until("the third turn", () => c.of("turn_ended")[2]);
  assert.deepEqual((decisions[1] as { updatedInput: { answers: unknown } }).updatedInput.answers, { "Which colour?": "red, blue" });

  await assert.rejects(session.steer("nothing running"), /no turn running/);
  await session.close();
});

test("Claude Code: a resumed session keeps its id and a branch gets a new one; a missing install says what to do", async () => {
  const fake = fakeClaude(async () => [result("ok")]);
  const claude = claudeAdapter({ command: "/bin/true", query: fake.query });
  const c = collect();
  const resumed = await claude.open(spec({ resume: "old-id" }), c.emit);
  await resumed.run({ key: "k", text: "go on", images: [] });
  await until("the turn", () => c.of("turn_ended")[0]);
  await resumed.close();
  assert.equal(fake.runs[0]!.options.resume, "old-id");
  assert.equal(fake.runs[0]!.options.sessionId, undefined);
  assert.equal(c.of("session")[0]!.externalId, "old-id");
  await (await claude.open(spec({ resume: "old-id", fork: true }), c.emit)).close();
  assert.equal(fake.runs[1]!.options.forkSession, true);
  assert.notEqual(fake.runs[1]!.options.sessionId, "old-id");

  const missing = await claudeAdapter({ command: "definitely-not-claude-xyz" }).check();
  assert.equal(missing.ok, false);
  assert.match(!missing.ok ? missing.error : "", /Claude Code isn't installed on the daemon's computer.*TOP_CLAUDE_PATH/);
});

test("Claude Code: a steer that lands as the turn ends is answered before the turn counts as over", async () => {
  let firstUuid = "";
  const fake = fakeClaude(async (message) => {
    if (!message.priority) {
      firstUuid = message.uuid ?? "";
      return [];
    }
    return [
      { ...(result("first answer") as object), user_message_uuids: [firstUuid] } as unknown as SDKMessage,
      { ...(result("after the steer") as object), user_message_uuids: [message.uuid] } as unknown as SDKMessage,
    ];
  });
  const claude = claudeAdapter({ command: "/bin/true", query: fake.query });
  const c = collect();
  const session = await claude.open(spec(), c.emit);
  await session.run({ key: "k", text: "work", images: [] });
  await until("the first message", () => fake.runs[0]!.messages.length === 1);
  await session.steer("also do this");
  const ended = await until("the turn", () => c.of("turn_ended")[0]);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(c.of("turn_ended").length, 1);
  assert.equal(ended.result, "after the steer");
  assert.equal(fake.runs[0]!.messages[1]!.priority, "next");
  await session.close();
});

test("Claude Code: cancelling between a turn's answer and its steered follow-up ends the turn as interrupted at once", async () => {
  const fake = fakeClaude(async (message) =>
    message.priority ? [] : [{ ...(result("first") as object), user_message_uuids: [message.uuid] } as unknown as SDKMessage],
  );
  const claude = claudeAdapter({ command: "/bin/true", query: fake.query });
  const c = collect();
  const session = await claude.open(spec(), c.emit);
  await session.run({ key: "k", text: "work", images: [] });
  await session.steer("and this");
  await until("both messages", () => fake.runs[0]!.messages.length === 2);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(c.of("turn_ended").length, 0, "the steered message is still to be answered");
  await session.interrupt();
  assert.equal(c.of("turn_ended")[0]!.status, "interrupted");
  await session.close();
});

test("Claude Code: a turn whose result can't account for every message still ends when Claude Code says it's idle", async () => {
  const fake = fakeClaude(async (message) =>
    message.priority
      ? [
          { ...(result("both done") as object), user_message_uuid: message.uuid } as unknown as SDKMessage,
          { type: "system", subtype: "session_state_changed", state: "idle" } as unknown as SDKMessage,
        ]
      : [],
  );
  const claude = claudeAdapter({ command: "/bin/true", query: fake.query });
  const c = collect();
  const session = await claude.open(spec(), c.emit);
  await session.run({ key: "k", text: "work", images: [] });
  await session.steer("and this");
  const ended = await until("the turn", () => c.of("turn_ended")[0]);
  assert.equal(ended.result, "both done");
  await session.close();
});

test("harness output is scrubbed of things that look like credentials", () => {
  assert.equal(redact("key sk-abcdefghijklmnop1234 ok"), "key [redacted] ok");
  assert.equal(redact("Authorization: Bearer abcdefghijklmnopqrstuvwxyz"), "Authorization: Bearer [redacted]");
  assert.equal(redact('{"access_token":"abcdef123456"}'), '{"access_token":"[redacted]"}');
  assert.equal(redact("nothing secret here"), "nothing secret here");
});

test("harnesses get neither the daemon's provider keys nor the identity of a Claude Code session it was started from", () => {
  const env = harnessEnv({
    PATH: "/bin",
    HOME: "/h",
    GITHUB_TOKEN: "kept for tools",
    STRIPE_TEST_API_KEY: "a project's own key",
    AWS_ACCESS_KEY_ID: "bedrock",
    AWS_SECRET_ACCESS_KEY: "bedrock",
    HF_TOKEN: "h",
    ANTHROPIC_API_KEY: "a",
    OPENAI_API_KEY: "o",
    ANTHROPIC_AUTH_TOKEN: "t",
    CLAUDECODE: "1",
    CLAUDE_CODE_MESSAGING_TOKEN: "parent-secret",
    CLAUDE_CODE_SESSION_ID: "p",
    CLAUDE_AGENT_SDK_CLIENT_APP: "top/1.0.0",
  });
  assert.deepEqual(env, { PATH: "/bin", HOME: "/h", GITHUB_TOKEN: "kept for tools", STRIPE_TEST_API_KEY: "a project's own key" });
});
