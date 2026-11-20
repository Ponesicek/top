import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative as relativePath } from "node:path";
import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, test } from "vitest";
import type { CollarDaemon } from "../src/collar/index.ts";
import { harnessLines, tasksGroup } from "../src/collar/tasks.ts";
import { claudeAdapter, type QueryFn } from "../src/tasks/claude.ts";
import { CLAUDE_CLOUD, claudeCloudAdapter } from "../src/tasks/claudecloud.ts";
import { testHooks } from "../src/tasks/cloud.ts";
import { codexAdapter } from "../src/tasks/codex.ts";
import { CODEX_CLOUD, codexCloudAdapter } from "../src/tasks/codexcloud.ts";
import type { Tasks } from "../src/tasks/coordinator.ts";
import { CAPABILITY_NOTES, findCli, type HarnessEvent, HarnessUnavailable, harnessEnv, type OpenSpec, redact } from "../src/tasks/harness.ts";
import { t3codeAdapter } from "../src/tasks/t3code.ts";
import { until } from "./harness.ts";

const FAKE_CODEX = join(import.meta.dirname, "fixtures", "fake-codex.mjs");
const FAKE_CODEX_CLOUD = join(import.meta.dirname, "fixtures", "fake-codex-cloud.mjs");
const FAKE_CLAUDE_CLOUD = join(import.meta.dirname, "fixtures", "fake-claude-cloud.mjs");

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

const FAKE_ENV = /^(FAKE_CODEX_|FAKE_CC_|FAKE_CL_)/;
afterEach(() => {
  for (const name of Object.keys(process.env)) if (FAKE_ENV.test(name)) delete process.env[name];
  delete process.env.CCR_FORCE_BUNDLE;
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

// ── Cloud harnesses, against stand-ins for their CLIs: nothing here reaches a vendor's cloud. ──

type Call = { args: string[]; cwd: string; prompt?: string; message?: string; description?: string; bundle: string | null; cloned?: boolean };
const calls = (dir: string): Call[] =>
  existsSync(join(dir, "calls.jsonl"))
    ? readFileSync(join(dir, "calls.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Call)
    : [];

/** Collects events, and saves every session id at once, as the coordinator does. */
const cloudCollect = (refuseSave?: string) => {
  const c = collect();
  return {
    ...c,
    emit: (event: HarnessEvent) => {
      c.emit(event);
      if (event.type === "session") event.saved?.(refuseSave ? new Error(refuseSave) : undefined);
    },
  };
};

const codexCloud = (over: Parameters<typeof codexCloudAdapter>[0] = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "top-cc-"));
  process.env.FAKE_CC_DIR = dir;
  return { dir, adapter: codexCloudAdapter({ command: FAKE_CODEX_CLOUD, firstPollMs: 20, maxPollMs: 40, ...over }) };
};
const cloudSpec = (options: Record<string, unknown>, over: Partial<OpenSpec> = {}) => spec({ cwd: "env_fake @ main", options, ...over });

test("the local harnesses and what bots are told about them are as they were before cloud harnesses came", () => {
  const local = [
    claudeAdapter({ command: "/nonexistent/claude" }),
    codexAdapter({ command: "/nonexistent/codex" }),
    t3codeAdapter({ file: "/nonexistent/t3.json" }),
  ];
  // Computed with the base commit's own `harnessLines` (71a26a2), before `where`, `guidance` and `follow` existed.
  assert.equal(
    harnessLines(local),
    [
      "- \"claude_code\" (Claude Code): can resume, fork, steer, queue, questions, images, fileChanges, usage, cancel, reconnect; can't durable. Options: effort (How much effort Claude puts into each answer. Default: Claude Code's own setting.); max_turns (Stop a turn after this many model round trips.).",
      "- \"codex\" (Codex): can resume, fork, steer, queue, images, fileChanges, usage, cancel, reconnect; can't questions, durable. Options: reasoning_effort (How hard the model thinks on each turn. Default: Codex's own setting.).",
      "- \"t3code\" (T3 Code): can resume, steer, queue, questions, fileChanges, cancel, reconnect, durable; can't fork, images, usage. Options: provider (T3 Code's provider instance that runs it, such as claudeAgent or codex. Default: the one that offers `model`, else its first ready one.).",
    ].join("\n"),
  );
  for (const adapter of local) {
    assert.equal(adapter.where, undefined, `${adapter.id} has no \`where\``);
    assert.equal(adapter.guidance, undefined);
    assert.equal("follow" in adapter.capabilities, false, `${adapter.id} doesn't say \`follow\`: Top follows it, as before`);
  }
  assert.deepEqual(local[0]!.capabilities, {
    resume: true,
    fork: true,
    steer: true,
    queue: true,
    questions: true,
    images: true,
    fileChanges: true,
    usage: true,
    cancel: true,
    reconnect: true,
    durable: false,
  });
  assert.deepEqual(local[1]!.capabilities, { ...local[0]!.capabilities, questions: false });
  assert.deepEqual(local[2]!.capabilities, {
    resume: true,
    fork: false,
    steer: true,
    queue: true,
    questions: true,
    images: false,
    fileChanges: true,
    usage: false,
    cancel: true,
    reconnect: true,
    durable: true,
  });
});

test("cloud harnesses are marked as such for bots, with what they need and what they may receive", () => {
  const lines = harnessLines([codexCloudAdapter({ command: "/nonexistent" }), claudeCloudAdapter({ command: "/nonexistent" })]);
  assert.match(
    lines,
    /^- "codex-cloud" \(Codex cloud\): can fileChanges, durable, follow; can't resume, fork, steer, queue, questions, images, usage, cancel, reconnect\./m,
  );
  assert.match(lines, /^- "claude-cloud" \(Claude Code cloud\): can resume; can't .*cancel.*follow\./m);
  assert.equal(lines.match(/Runs in its vendor's cloud, not on this computer: name it in `harness` to use it, it's never a default\./g)?.length, 2);
  assert.match(
    lines,
    /environment id that the user gives you: they see theirs in the `codex cloud` picker, or as `environment_id` of earlier tasks in `codex cloud list --json`; Top doesn't list them/,
  );
  assert.match(lines, /Top can't start a Claude Code cloud session: the official CLI only starts one in an interactive terminal\. The user starts it/);
  assert.match(lines, /queues one message into that session, which isn't a live steer/);
  assert.match(lines, /Top uploads nothing from this computer's checkouts/);
  assert.match(CAPABILITY_NOTES.follow, /`handed_off`, which means Top doesn't know how it goes/);
});

test("Codex cloud: it's ready only with a ChatGPT sign-in and a CLI that has `codex cloud exec`, and never shows an API key", async () => {
  codexCloud();
  assert.deepEqual(await codexCloud().adapter.check(), { ok: true, version: "codex-cli 0.171.0" });
  process.env.FAKE_CC_LOGIN = "apikey";
  const key = await codexCloud().adapter.check();
  assert.equal(key.ok, false);
  assert.match((key as { error: string }).error, /signed in with an API key, and Codex cloud needs a ChatGPT sign-in: run `codex login`/);
  assert.doesNotMatch((key as { error: string }).error, /sk-|WXYZ/);
  process.env.FAKE_CC_LOGIN = "none";
  assert.match(((await codexCloud().adapter.check()) as { error: string }).error, /isn't signed in with ChatGPT.*run `codex login`/);
  process.env.FAKE_CC_LOGIN = "chatgpt";
  process.env.FAKE_CC_OLD = "1";
  assert.match(((await codexCloud().adapter.check()) as { error: string }).error, /has no `codex cloud` with --attempts\. Update the Codex CLI/);
  const { dir, adapter } = codexCloud();
  delete process.env.FAKE_CC_OLD;
  await adapter.check();
  assert.ok(
    calls(dir).every((call) => call.cwd !== process.cwd() && !existsSync(call.cwd)),
    "each ran in a private folder, removed after",
  );
});

test("Codex cloud: a task is sent once from a private folder after its marker is saved, then followed to its result", async () => {
  const { dir, adapter } = codexCloud();
  process.env.FAKE_CC_STATES = "PENDING,PENDING,READY";
  const c = cloudCollect();
  const session = await adapter.open(cloudSpec({ environment: "env_fake", branch: "main", attempts: 2 }), c.emit);
  await session.run({ key: "task_1", text: "fix the login bug\nwith care", images: [] });
  const ended = await until("the task to end", () => c.of("turn_ended")[0]);
  assert.equal(ended.status, "completed");
  assert.match(ended.result!, /^Codex cloud finished: Fix the login bug\n\+12\/-3 • 2 files\nhttps:\/\/chatgpt\.com\/codex\/tasks\/task_e_1\n/);
  assert.match(ended.result!, /aren't applied anywhere: see them with `codex cloud diff task_e_1` and apply them with `codex cloud apply task_e_1`/);
  assert.match(ended.result!, /asked for 2 attempts; this is attempt 1\. See the others with `codex cloud diff task_e_1 --attempt 2`/);
  assert.deepEqual(
    c.of("session").map((e) => e.externalId),
    ["pending:task_1", "task_e_1"],
    "the marker that it's being sent comes first, then its id",
  );
  assert.ok(c.of("log").some((e) => e.kind === "file_change" && e.text === "~ src/login.ts\n+ src/login.test.ts"));
  const all = calls(dir);
  const exec = all.filter((call) => call.args[1] === "exec");
  assert.equal(exec.length, 1);
  assert.deepEqual(exec[0]!.args, ["cloud", "exec", "--env", "env_fake", "--branch", "main", "--attempts", "2", "-"]);
  assert.equal(exec[0]!.prompt, "fix the login bug\nwith care", "the prompt goes on stdin");
  assert.equal(all.filter((call) => call.args[1] === "status").length, 3);
  assert.ok(
    all.every((call) => call.cwd !== process.cwd() && !existsSync(call.cwd)),
    "never in a checkout: each in a private folder, gone after",
  );
  assert.equal(existsSync(join(process.cwd(), "error.log")), false);
  await session.close();
});

test("Codex cloud: an error there fails the task, never shown as done", async () => {
  codexCloud();
  process.env.FAKE_CC_STATES = "PENDING,ERROR";
  process.env.FAKE_CC_TITLE = "Fix it sk-abcdefghijklmnopqrstu";
  const c = cloudCollect();
  const session = await codexCloud().adapter.open(cloudSpec({ environment: "env_fake", branch: "main" }), c.emit);
  await session.run({ key: "k", text: "go", images: [] });
  const ended = await until("the task to end", () => c.of("turn_ended")[0]);
  assert.equal(ended.status, "failed");
  assert.match(
    ended.error!,
    /^Codex cloud reports an error for it \(it failed there, or was cancelled there\): Fix it \[redacted\]\. See https:\/\/chatgpt\.com\/codex\/tasks\/task_e_1$/,
  );
});

test("Codex cloud: a send it refused fails plainly; one whose outcome is unknown says so, and nothing is sent twice", async () => {
  const outcome = async (mode: string, over: Parameters<typeof codexCloudAdapter>[0] = {}) => {
    const { dir, adapter } = codexCloud(over);
    process.env.FAKE_CC_EXEC = mode;
    const c = cloudCollect();
    const session = await adapter.open(cloudSpec({ environment: "env_nope", branch: "main" }), c.emit);
    await session.run({ key: "k", text: "go", images: [] });
    const ended = await until(`the ${mode} send to end`, () => c.of("turn_ended")[0], 8_000);
    await session.close();
    assert.equal(calls(dir).filter((call) => call.args[1] === "exec").length, 1);
    assert.equal(calls(dir).filter((call) => call.args[1] === "status").length, 0, "nothing to follow");
    return { ended, ids: c.of("session").map((e) => e.externalId) };
  };
  const notFound = await outcome("notfound");
  assert.equal(notFound.ended.status, "failed");
  assert.match(notFound.ended.error!, /^Codex cloud didn't take it: Error: environment 'env_nope' not found; run `codex cloud`/);

  const unknown = await outcome("http500");
  assert.match(
    unknown.ended.error!,
    /^It may or may not have reached Codex cloud \(Error: request failed: 500.*\[redacted\].*\)\. Check `codex cloud list` before starting it again: Top never sends it twice\.$/,
  );
  assert.doesNotMatch(unknown.ended.error!, /sk-live/);

  const slow = await outcome("hang", { submitTimeoutMs: 300 });
  assert.match(slow.ended.error!, /^It may or may not have reached Codex cloud \(`codex cloud exec` didn't finish within/);

  const evil = await outcome("evil");
  assert.match(evil.ended.error!, /^It may or may not have reached Codex cloud/);
  assert.deepEqual(evil.ids, ["pending:k"], "a link off chatgpt.com/codex/tasks is never taken as the task");
});

test("Codex cloud: nothing is sent unless the marker that it's being sent was saved first", async () => {
  const { dir, adapter } = codexCloud();
  const c = cloudCollect("disk full");
  const session = await adapter.open(cloudSpec({ environment: "env_fake", branch: "main" }), c.emit);
  await session.run({ key: "k", text: "go", images: [] });
  const ended = await until("the task to end", () => c.of("turn_ended")[0]);
  assert.deepEqual(ended, { type: "turn_ended", status: "failed", error: "It wasn't sent: disk full" });
  assert.equal(calls(dir).length, 0);
});

test("Codex cloud: after a restart it follows a task it knows by id, and never resends one it may have sent", async () => {
  const { dir, adapter } = codexCloud();
  process.env.FAKE_CC_STATES = "READY";
  const c = cloudCollect();
  const known = await adapter.open(cloudSpec({ environment: "env_fake", branch: "main" }, { resume: "task_e_7" }), c.emit);
  await known.run({ key: "k", text: "go", images: [] });
  const done = await until("the known task to end", () => c.of("turn_ended")[0]);
  assert.equal(done.status, "completed");
  assert.match(done.result!, /task_e_7/);

  const d = cloudCollect();
  const unsure = await adapter.open(cloudSpec({ environment: "env_fake", branch: "main" }, { resume: "pending:k" }), d.emit);
  await unsure.run({ key: "k", text: "go", images: [] });
  const failed = await until("the unsure task to end", () => d.of("turn_ended")[0]);
  assert.equal(failed.status, "failed");
  assert.match(failed.error!, /^Top restarted while it was sending this to Codex cloud, so it may or may not have got there\. Check `codex cloud list`/);
  assert.equal(calls(dir).filter((call) => call.args[1] === "exec").length, 0);
});

test("Codex cloud: Top stops following after its limit and says the status is unknown; it takes no folder or model", async () => {
  const { adapter } = codexCloud({ followForMs: 100 });
  process.env.FAKE_CC_STATES = "PENDING";
  const c = cloudCollect();
  const session = await adapter.open(cloudSpec({ environment: "env_fake", branch: "main" }, { resume: "task_e_3" }), c.emit);
  await session.run({ key: "k", text: "go", images: [] });
  const ended = await until("it to give up", () => c.of("turn_ended")[0]);
  assert.equal(ended.status, "failed");
  assert.match(ended.error!, /^Top stopped following it after .*; its status is unknown\. See https:\/\/chatgpt\.com\/codex\/tasks\/task_e_3$/);
  await assert.rejects(session.steer("more"), /Codex cloud can't take messages into a task/);
  await assert.rejects(session.interrupt(), /Codex cloud can't stop a task/);
  await assert.rejects(adapter.locate!("/tmp", { options: { environment: "e", branch: "b" }, model: undefined }), /takes no `cwd`/);
  await assert.rejects(adapter.locate!(undefined, { options: { environment: "e", branch: "b" }, model: "gpt" }), /Leave out `model`/);
  assert.deepEqual(await adapter.locate!(undefined, { options: { environment: "env_1", branch: "dev" }, model: undefined }), { cwd: "env_1 @ dev" });
  assert.equal(adapter.id, CODEX_CLOUD);
});

const claudeCloud = (over: Parameters<typeof claudeCloudAdapter>[0] = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "top-cl-"));
  process.env.FAKE_CL_DIR = dir;
  return { dir, adapter: claudeCloudAdapter({ command: FAKE_CLAUDE_CLOUD, ...over }) };
};
const SESSION = "session_01FAKEFAKEFAKE";
const sessionSpec = (over: Partial<OpenSpec> = {}) => spec({ cwd: `claude.ai/code/${SESSION}`, options: { cloud_session: SESSION }, ...over });

test("Claude Code cloud: it's ready only with a claude.ai sign-in, and keeps nothing else the status says", async () => {
  const { adapter } = claudeCloud();
  assert.deepEqual(await adapter.check(), { ok: true, version: "2.1.329 (Claude Code)" });
  process.env.FAKE_CL_AUTH = "api_key";
  const key = (await adapter.check()) as { ok: false; error: string };
  assert.equal(
    key.error,
    "Claude Code is signed in with api_key, and Claude Code cloud needs a claude.ai sign-in: run `claude auth login` and sign in with your claude.ai account.",
  );
  process.env.FAKE_CL_AUTH = "none";
  const none = (await adapter.check()) as { ok: false; error: string };
  assert.match(none.error, /isn't signed in, and Claude Code cloud needs a claude\.ai sign-in/);
  assert.doesNotMatch(`${key.error}${none.error}`, /someone@example|org_secret|API key/);
});

test("Claude Code cloud: `cloud_session` is a session id or an official claude.ai/code link, kept as the bare id", async () => {
  const { adapter } = claudeCloud();
  const locate = (cloud_session: string) => adapter.locate!(undefined, { options: { cloud_session }, model: undefined });
  for (const given of [SESSION, `  ${SESSION} `, `https://claude.ai/code/${SESSION}`, `https://claude.ai/code/${SESSION}?from=cli&m=0`])
    assert.deepEqual(await locate(given), { cwd: `claude.ai/code/${SESSION}`, options: { cloud_session: SESSION } }, given);
  assert.deepEqual((await locate("cse_01ABC")).options, { cloud_session: "cse_01ABC" });
  for (const bad of [
    "",
    "fix the login bug",
    "session_01 extra",
    "http://claude.ai/code/session_01ABC",
    "https://claude.ai.evil.example/code/session_01ABC",
    "https://evil.example/?next=https://claude.ai/code/session_01ABC",
    "https://evil.example/#https://claude.ai/code/session_01ABC",
    "https://claude.ai/code/session_01ABC/more",
    "https://user@claude.ai.evil.example/code/session_01ABC",
  ])
    await assert.rejects(locate(bad), /`cloud_session` has to be a Claude Code cloud session's id .* Top can't start one: ask the user to start it/, bad);
  await assert.rejects(adapter.locate!("/tmp", { options: { cloud_session: SESSION }, model: undefined }), /takes no `cwd`/);
  await assert.rejects(adapter.locate!(undefined, { options: { cloud_session: SESSION }, model: "opus" }), /leave out `model`/);
});

test("Claude Code cloud: a task queues one message into the existing session and is handed off; a refusal fails, scrubbed", async () => {
  const { dir, adapter } = claudeCloud();
  process.env.CCR_FORCE_BUNDLE = "1";
  const c = cloudCollect();
  const session = await adapter.open(sessionSpec(), c.emit);
  assert.deepEqual(c.of("session"), [{ type: "session", externalId: SESSION }], "the id is saved at once, for later tasks in this session");
  await session.run({ key: "k", text: "fix the login bug", images: [] });
  const ended = await until("the send", () => c.of("turn_ended")[0]);
  assert.deepEqual(ended, {
    type: "turn_ended",
    status: "handed_off",
    result: `Queued a message into Claude Code cloud session https://claude.ai/code/${SESSION}. It's a queued message, not a live steer: Top can't see whether or when the session acts on it, or its result.`,
  });
  const [sent] = calls(dir).filter((call) => call.args.includes("-p"));
  assert.deepEqual(sent!.args, ["-p", "--cloud", SESSION, "--output-format", "json"]);
  assert.equal(sent!.message, "fix the login bug", "the message goes on stdin");
  assert.equal(sent!.bundle, null);
  assert.ok(sent!.cwd !== process.cwd() && !existsSync(sent!.cwd), "from an empty private folder, gone after: no checkout goes with it");
  assert.equal(calls(dir).filter((call) => call.args[0] === "--cloud").length, 0, "it never tries to start a session");

  const later = cloudCollect();
  await (await adapter.open(sessionSpec({ options: {}, resume: "cse_01OTHER" }), later.emit)).run({ key: "k1", text: "more", images: [] });
  await until("the follow-up", () => later.of("turn_ended")[0]);
  assert.deepEqual(calls(dir).at(-1)!.args, ["-p", "--cloud", "cse_01OTHER", "--output-format", "json"], "a continued session sends to its saved id");

  process.env.FAKE_CL_SEND = "archived";
  const d = cloudCollect();
  await (await adapter.open(sessionSpec(), d.emit)).run({ key: "k2", text: "more", images: [] });
  const archived = await until("the refusal", () => d.of("turn_ended")[0]);
  assert.equal(archived.status, "failed");
  assert.equal(archived.error, `Claude Code cloud didn't take the message: cloud session ${SESSION} is archived and cannot accept new messages`);

  process.env.FAKE_CL_SEND = "secret";
  const e = cloudCollect();
  await (await adapter.open(sessionSpec(), e.emit)).run({ key: "k3", text: "more", images: [] });
  assert.match((await until("the scrubbed refusal", () => e.of("turn_ended")[0])).error!, /Bearer \[redacted\]/);

  process.env.FAKE_CL_SEND = "silent";
  const f = cloudCollect();
  await (await adapter.open(sessionSpec(), f.emit)).run({ key: "k4", text: "more", images: [] });
  assert.match(
    (await until("the unknown send", () => f.of("turn_ended")[0])).error!,
    new RegExp(`^The message may or may not have reached https://claude\\.ai/code/${SESSION} .*Top never resends it\\.$`),
  );
  await assert.rejects(session.interrupt(), /can't stop a session/);
  await assert.rejects(session.steer("x"), /can't take messages/);
  assert.equal(adapter.id, CLAUDE_CLOUD);
});

// ── Review rounds ──

test("S5 Codex cloud: a task id that redaction would change is treated as no id", async () => {
  codexCloud();
  process.env.FAKE_CC_EXEC = "secretid";
  const c = cloudCollect();
  await (await codexCloud().adapter.open(cloudSpec({ environment: "env_fake", branch: "main" }), c.emit)).run({ key: "k", text: "go", images: [] });
  const ended = await until("the send to end", () => c.of("turn_ended")[0]);
  assert.match(ended.error!, /^It may or may not have reached Codex cloud/);
  assert.deepEqual(
    c.of("session").map((e) => e.externalId),
    ["pending:k"],
  );
});

test("S6 a cloud CLI is never started once its session has closed, even when that happens after its folder was made", async () => {
  // The hook runs once a call's private folder exists, the last step before the process: the session closes right there.
  const closeAt = (session: { close: () => Promise<void> }) => {
    testHooks.prepared = async () => {
      testHooks.prepared = undefined;
      await session.close();
    };
  };
  try {
    // Codex cloud's send: only its marker is left, so a restart says "may or may not", and nothing was sent.
    const { dir, adapter } = codexCloud();
    const c = cloudCollect();
    const send = await adapter.open(cloudSpec({ environment: "env_fake", branch: "main" }), c.emit);
    closeAt(send);
    await send.run({ key: "k", text: "go", images: [] });
    await until("the folder to be made", () => testHooks.prepared === undefined);
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(
      c.of("session").map((e) => e.externalId),
      ["pending:k"],
    );
    assert.deepEqual(c.of("turn_ended"), []);

    // Codex cloud's status check.
    const d = cloudCollect();
    const follow = await adapter.open(cloudSpec({ environment: "env_fake", branch: "main" }, { resume: "task_e_9" }), d.emit);
    closeAt(follow);
    await follow.run({ key: "k", text: "go", images: [] });
    await until("the folder to be made", () => testHooks.prepared === undefined);
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(calls(dir), [], "neither exec nor status ran");

    // Claude Code cloud's send.
    const cl = claudeCloud();
    const queued = await cl.adapter.open(sessionSpec(), cloudCollect().emit);
    closeAt(queued);
    await queued.run({ key: "k", text: "more", images: [] });
    await until("the folder to be made", () => testHooks.prepared === undefined);
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(calls(cl.dir), [], "nothing was sent");
  } finally {
    testHooks.prepared = undefined;
  }
});

test("S10 task_start says a cloud harness runs in the cloud, never that its `cwd` is a folder on another computer", () => {
  const cloud = { ...claudeCloudAdapter({ command: "/nonexistent" }), locate: async () => ({ cwd: "x" }) };
  const tools = tasksGroup({ tasks: { adapters: [cloud] } as unknown as Tasks } as unknown as CollarDaemon);
  const description = tools.find((t) => t.name === "task_start")!.description;
  assert.doesNotMatch(description, /"claude-cloud" runs on another computer/);
  assert.match(description, /Runs in its vendor's cloud/);
});
