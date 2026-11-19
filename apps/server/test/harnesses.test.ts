import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, test } from "vitest";
import { claudeAdapter, policyOptions, projectInstructions, type QueryFn, sessionGrants, userSettingsEnv } from "../src/tasks/claude.ts";
import { codexAdapter } from "../src/tasks/codex.ts";
import { type HarnessEvent, HarnessUnavailable, harnessEnv, type OpenSpec, redact } from "../src/tasks/harness.ts";
import { until } from "./harness.ts";

const FAKE_CODEX = join(import.meta.dirname, "fixtures", "fake-codex.mjs");

const spec = (over: Partial<OpenSpec> = {}): OpenSpec => ({
  cwd: mkdtempSync(join(tmpdir(), "top-harness-")),
  policy: "workspace_write",
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

test("Codex: a thread runs in its sandbox with approvals on, and the turn's answer is the result", async () => {
  const log = join(mkdtempSync(join(tmpdir(), "top-codex-")), "log.jsonl");
  process.env.FAKE_CODEX_LOG = log;
  const codex = codexAdapter({ command: FAKE_CODEX });
  assert.deepEqual(await codex.check(), { ok: true, version: "codex-cli 0.0.0-fake" });
  const c = collect();
  const where = spec();
  const session = await codex.open(where, c.emit);
  assert.deepEqual(c.of("session"), [{ type: "session", externalId: "thr_fake", model: "gpt-fake" }]);
  await session.run({ text: "say hi", images: [] });
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
  assert.deepEqual(sent.find((m) => m.method === "thread/start")!.params, {
    cwd: where.cwd,
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandbox: "workspace-write",
  });
  assert.equal(sent.find((m) => m.method === "turn/start")!.params!.approvalsReviewer, "user", "a model never reviews approvals in the user's place");
  const policy = sent.find((m) => m.method === "turn/start")!.params!.sandboxPolicy as { writableRoots: string[]; excludeSlashTmp: boolean };
  assert.equal(policy.writableRoots[0], where.cwd);
  assert.match(policy.writableRoots[1]!, /top-codex-/, "a private temp folder, not all of /tmp");
  assert.equal(policy.excludeSlashTmp, true);
  assert.ok(!sent.some((m) => m.method?.startsWith("account/login")), "it never signs in or out");
  await session.close();
});

test("Codex: approvals and questions round-trip, steering names the turn, and interrupt ends it", async () => {
  const log = join(mkdtempSync(join(tmpdir(), "top-codex-")), "log.jsonl");
  process.env.FAKE_CODEX_LOG = log;
  const codex = codexAdapter({ command: FAKE_CODEX });
  const c = collect();
  const session = await codex.open(spec({ policy: "read_only", resume: "thr_old" }), c.emit);
  assert.equal(c.of("session")[0]!.externalId, "thr_old");
  assert.deepEqual(codexLog(log).find((m) => m.method === "thread/resume")!.params, {
    threadId: "thr_old",
    cwd: (codexLog(log).find((m) => m.method === "thread/resume")!.params as { cwd: string }).cwd,
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandbox: "read-only",
    excludeTurns: true,
  });

  await session.run({ text: "approve this", images: [] });
  const request = await until("the approval", () => c.of("request")[0]?.request);
  assert.equal(request.kind, "approval");
  assert.equal(request.title, "Run `npm test`");
  assert.match(request.detail!, /needs network/);
  session.answer(request.id, { kind: "approval", decision: "allow_for_session" });
  const ended = await until("the turn to end", () => c.of("turn_ended")[0]);
  assert.equal(ended.result, "decision: acceptForSession");
  assert.deepEqual(c.of("resolved"), [], "an answered request isn't reported as withdrawn when Codex confirms it");
  assert.ok(c.of("log").some((e) => e.kind === "command" && e.text.startsWith("$ npm test (exit 0)")));

  await session.run({ text: "a question", images: [] });
  const question = await until("the question", () => c.of("request")[1]?.request);
  assert.deepEqual(question.questions, [
    { id: "color", question: "Which colour?", header: "Colour", options: [{ label: "red", description: "warm" }, { label: "blue" }] },
  ]);
  session.answer(question.id, { kind: "question", answers: { color: ["blue"] } });
  assert.equal((await until("the second turn", () => c.of("turn_ended")[1])).result, 'answer: {"color":{"answers":["blue"]}}');

  await session.run({ text: "wait for me", images: ["/tmp/x.png"] });
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
  const missing = codexAdapter({ command: "/nonexistent/codex" });
  const checked = await missing.check();
  assert.equal(checked.ok, false);
  assert.match(!checked.ok ? checked.error : "", /Codex isn't installed on the daemon's computer.*TOP_CODEX_PATH/);
});

type FakeQuery = { messages: SDKUserMessage[]; options: Options; interrupted: number };

function fakeClaude(
  script: (message: SDKUserMessage, options: Options) => Promise<SDKMessage[]>,
  rules: (options: Options) => { behavior: string; source: string; rule: string }[] = () => [],
) {
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
      listPermissionRules: async () => ({ state: { rules: rules(options) } }),
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

test("Claude Code: the policy maps to its permission mode and sandbox, never to skipped approvals by accident", () => {
  assert.deepEqual(policyOptions("workspace_write", "/w", true), {
    permissionMode: "acceptEdits",
    sandbox: { enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true },
  });
  assert.deepEqual(policyOptions("workspace_write", "/w", false), { permissionMode: "acceptEdits" }, "no sandbox: commands ask instead");
  const readOnly = policyOptions("read_only", "/w", true);
  assert.equal(readOnly.permissionMode, "default");
  assert.deepEqual(readOnly.disallowedTools, ["Edit", "Write", "NotebookEdit"]);
  assert.equal(readOnly.sandbox?.allowUnsandboxedCommands, false);
  assert.equal(readOnly.sandbox?.autoAllowBashIfSandboxed, false, "read only: every shell command asks");
  assert.deepEqual(policyOptions("read_only", "/w", false).disallowedTools, ["Edit", "Write", "NotebookEdit", "Bash"], "no sandbox: no shell at all");
  assert.deepEqual(policyOptions("full_access", "/w", true), { permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true });
});

test("Claude Code: approvals stay in the session, questions answer by their text, and steering goes into the turn", async () => {
  const decisions: unknown[] = [];
  const fake = fakeClaude(async (message, options) => {
    const text = textOf(message);
    if (text.includes("approve")) {
      const signal = new AbortController().signal;
      decisions.push(
        await options.canUseTool!("Bash", { command: "npm test" }, {
          signal,
          toolUseID: "tu1",
          requestId: "r1",
          suggestions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm test" }], behavior: "allow", destination: "localSettings" }],
        } as never),
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
  const claude = claudeAdapter({ command: "/bin/true", query: fake.query, sandbox: async () => true });
  const c = collect();
  const session = await claude.open(spec(), c.emit);
  const options = fake.runs[0]!.options;
  assert.equal(options.permissionMode, "acceptEdits");
  assert.equal(options.pathToClaudeCodeExecutable, "/bin/true", "it drives the user's own Claude Code");
  assert.deepEqual(options.systemPrompt, { type: "preset", preset: "claude_code" });
  assert.match(String(options.sessionId), /^[0-9a-f-]{36}$/, "a new session has its id before anything runs");
  assert.deepEqual(c.of("session"), [], "no session is claimed before Claude Code confirms it");
  assert.deepEqual(options.settingSources, [], "no settings files: their allow rules and hooks would skip the card");

  await session.run({ text: "hello", images: [] });
  await until("the session", () => c.of("session")[0]);
  assert.equal(c.of("session")[0]!.externalId, options.sessionId);
  assert.equal((await until("the turn", () => c.of("turn_ended")[0])).result, "hi: hello");
  assert.ok(c.of("log").some((e) => e.kind === "file_change" && e.text === "~ /w/a.ts"));
  assert.equal(c.of("usage").at(-1)!.usage.costUsd, 0.01);

  await session.run({ text: "approve", images: [] });
  const approval = await until("the approval", () => c.of("request")[0]?.request);
  assert.equal(approval.title, "Run `npm test`");
  assert.deepEqual(approval.decisions, ["allow", "allow_for_session", "deny"]);
  session.answer(approval.id, { kind: "approval", decision: "allow_for_session" });
  await until("the second turn", () => c.of("turn_ended")[1]);
  assert.deepEqual(decisions[0], {
    behavior: "allow",
    updatedInput: { command: "npm test" },
    updatedPermissions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm test" }], behavior: "allow", destination: "session" }],
  });

  await session.run({ text: "ask me", images: [] });
  const question = await until("the question", () => c.of("request")[1]?.request);
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
  const claude = claudeAdapter({ command: "/bin/true", query: fake.query, sandbox: async () => false });
  const c = collect();
  const resumed = await claude.open(spec({ resume: "old-id" }), c.emit);
  await resumed.run({ text: "go on", images: [] });
  await until("the turn", () => c.of("turn_ended")[0]);
  await resumed.close();
  assert.equal(fake.runs[0]!.options.sandbox, undefined);
  assert.match(c.of("log")[0]!.text, /sandbox isn't available.*commands ask for approval first/);
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
  });
  assert.deepEqual(env, { PATH: "/bin", HOME: "/h", GITHUB_TOKEN: "kept for tools", STRIPE_TEST_API_KEY: "a project's own key" });
});

test("Claude Code: 'allow for this session' grants only rules and folders, for the session, and never changes its mode", () => {
  assert.deepEqual(
    sessionGrants([
      { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm test" }], behavior: "allow", destination: "localSettings" },
      { type: "addRules", rules: [{ toolName: "Bash" }], behavior: "deny", destination: "userSettings" },
      { type: "setMode", mode: "bypassPermissions", destination: "userSettings" },
      { type: "addDirectories", directories: ["/elsewhere"], destination: "projectSettings" },
    ]),
    [
      { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm test" }], behavior: "allow", destination: "session" },
      { type: "addDirectories", directories: ["/elsewhere"], destination: "session" },
    ],
  );
});

test("Claude Code: the project's instruction files, from the repository root down, are passed in with their imports, since its settings files aren't loaded", async () => {
  const repo = mkdtempSync(join(tmpdir(), "top-claude-md-"));
  assert.equal(await projectInstructions(repo), undefined);
  mkdirSync(join(repo, ".git"));
  mkdirSync(join(repo, "app", "src"), { recursive: true });
  writeFileSync(join(repo, "CLAUDE.md"), "@AGENTS.md\n@../../etc/passwd");
  writeFileSync(join(repo, "AGENTS.md"), "Use tabs.");
  writeFileSync(join(repo, "app", "AGENTS.md"), "App rules.");
  const text = (await projectInstructions(join(repo, "app", "src")))!;
  assert.match(
    text,
    /<file path="[^"]*\/CLAUDE\.md">\nUse tabs\.\n@\.\.\/\.\.\/etc\/passwd\n<\/file>/,
    "imports inside the repository are expanded, others aren't read",
  );
  assert.match(text, /app\/AGENTS\.md">\nApp rules\./, "a folder without CLAUDE.md gives its AGENTS.md");
  assert.ok(text.indexOf("Use tabs.") < text.indexOf("App rules."), "the root comes first");
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
  const claude = claudeAdapter({ command: "/bin/true", query: fake.query, sandbox: async () => true });
  const c = collect();
  const session = await claude.open(spec(), c.emit);
  await session.run({ text: "work", images: [] });
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
  const claude = claudeAdapter({ command: "/bin/true", query: fake.query, sandbox: async () => true });
  const c = collect();
  const session = await claude.open(spec(), c.emit);
  await session.run({ text: "work", images: [] });
  await session.steer("and this");
  await until("both messages", () => fake.runs[0]!.messages.length === 2);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(c.of("turn_ended").length, 0, "the steered message is still to be answered");
  await session.interrupt();
  assert.equal(c.of("turn_ended")[0]!.status, "interrupted");
  await session.close();
});

test("Claude Code: imports never leave the repository, through a symlink either, and a file importing itself is read once", async () => {
  const outside = mkdtempSync(join(tmpdir(), "top-outside-"));
  writeFileSync(join(outside, "secret.md"), "SECRET");
  const repo = mkdtempSync(join(tmpdir(), "top-claude-md-"));
  mkdirSync(join(repo, ".git"));
  symlinkSync(join(outside, "secret.md"), join(repo, "linked.md"));
  writeFileSync(join(repo, "CLAUDE.md"), "Top.\n@linked.md\n@CLAUDE.md\n@notes.md");
  writeFileSync(join(repo, "notes.md"), "Notes.\n@notes.md");
  const text = (await projectInstructions(repo))!;
  assert.ok(!text.includes("SECRET"), "a symlink out of the repository isn't followed");
  assert.equal(text.match(/Notes\./g)?.length, 1, "each file is read once");
  assert.match(text, /@linked\.md/);
});

test("Claude Code: outside a repository only the task folder's own instructions are used", async () => {
  const parent = mkdtempSync(join(tmpdir(), "top-no-git-"));
  writeFileSync(join(parent, "CLAUDE.md"), "Parent rules.");
  mkdirSync(join(parent, "work"));
  writeFileSync(join(parent, "work", "AGENTS.md"), "Work rules.\n@extra.md");
  writeFileSync(join(parent, "work", "extra.md"), "Extra.");
  const text = (await projectInstructions(join(parent, "work")))!;
  assert.ok(!text.includes("Parent rules."));
  assert.match(text, /Work rules\.\nExtra\./);
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
  const claude = claudeAdapter({ command: "/bin/true", query: fake.query, sandbox: async () => true });
  const c = collect();
  const session = await claude.open(spec(), c.emit);
  await session.run({ text: "work", images: [] });
  await session.steer("and this");
  const ended = await until("the turn", () => c.of("turn_ended")[0]);
  assert.equal(ended.result, "both done");
  await session.close();
});

test("Claude Code: long instructions keep the nearest folder's files whole and clip the root's, with their headers", async () => {
  const repo = mkdtempSync(join(tmpdir(), "top-claude-md-"));
  mkdirSync(join(repo, ".git"));
  mkdirSync(join(repo, "app"));
  writeFileSync(join(repo, "CLAUDE.md"), "root ".repeat(10_000));
  writeFileSync(join(repo, "app", "CLAUDE.md"), "Nearest rules.");
  const text = (await projectInstructions(join(repo, "app")))!;
  assert.ok(text.length < 33 * 1024);
  assert.match(text, /<file path="[^"]*\/CLAUDE\.md">\nroot root[^<]*\n…\n<\/file>\n\n<file path="[^"]*\/app\/CLAUDE\.md">\nNearest rules\.\n<\/file>$/);
});

test("Codex: a question for a secret is declined (Codex keeps answers in its history), and a permission card shows everything it grants", async () => {
  const log = join(mkdtempSync(join(tmpdir(), "top-codex-")), "log.jsonl");
  process.env.FAKE_CODEX_LOG = log;
  const codex = codexAdapter({ command: FAKE_CODEX });
  assert.equal(codex.capabilities.questions, false, "Codex's default mode doesn't ask questions");
  const c = collect();
  const session = await codex.open(spec(), c.emit);
  await session.run({ text: "a secret please", images: [] });
  assert.equal((await until("the turn", () => c.of("turn_ended")[0])).result, "secret answer: {}");
  assert.deepEqual(c.of("request"), []);

  await session.run({ text: "permissions please", images: [] });
  const request = await until("the card", () => c.of("request")[0]?.request);
  assert.match(request.detail!, /"entries"[\s\S]*\/home\/\*\*/, "the card lists every grant, entries included");
  session.answer(request.id, { kind: "approval", decision: "deny" });
  assert.equal((await until("the turn", () => c.of("turn_ended")[1])).result, 'granted: {"permissions":{},"scope":"turn"}');

  await session.run({ text: "permissions please, with a long reason", images: [] });
  const long = await until("the second card", () => c.of("request")[1]?.request);
  assert.ok(long.detail!.length <= 2_000);
  assert.ok(long.detail!.startsWith("Everything it asks for:\n") && long.detail!.includes('"/home/**"'), "a long reason never pushes the grant off the card");
  session.answer(long.id, { kind: "approval", decision: "deny" });
  await until("the turn", () => c.of("turn_ended")[2]);

  await session.run({ text: "huge permissions please", images: [] });
  assert.equal((await until("the turn", () => c.of("turn_ended")[3])).result, 'granted: {"permissions":{},"scope":"turn"}');
  assert.equal(c.of("request").length, 2, "a request too big to show isn't put on a card");
  await session.close();
});

test("Claude Code: the user's Claude settings only lend their environment (a gateway's address, say)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "top-claude-config-"));
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://gateway", N: 1 }, permissions: { allow: ["Bash(*)"] } }));
  assert.deepEqual(await userSettingsEnv({ CLAUDE_CONFIG_DIR: dir }), { ANTHROPIC_BASE_URL: "https://gateway" });
  assert.deepEqual(await userSettingsEnv({ CLAUDE_CONFIG_DIR: join(dir, "none") }), {});
});

test("Claude Code: a task won't start under a restricted policy when Claude Code applies allow rules Top can't turn off", async () => {
  const fake = fakeClaude(
    async () => [],
    () => [{ behavior: "allow", source: "policySettings", rule: "Bash(*)" }],
  );
  const claude = claudeAdapter({ command: "/bin/true", query: fake.query, sandbox: async () => true });
  await assert.rejects(
    claude.open(spec(), () => {}),
    (error: unknown) => error instanceof HarnessUnavailable && /allow Bash\(\*\) \(policySettings\) without asking/.test(error.message),
  );
  const session = await claude.open(spec({ policy: "full_access" }), () => {});
  await session.close();
});
