import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as Effect from "effect/Effect";
import Type from "typebox";
import { test } from "vitest";
import { catchUp, promptUuid, subscriptionProblem } from "../src/claudeRuntime.ts";
import { type FakeClaude, fakeClaude } from "../src/fakeClaude.ts";
import { textOf } from "../src/messages.ts";
import { fromPromise, type TopTool, text } from "../src/tools.ts";
import { type Harness, harness, idle, until } from "./harness.ts";

const CLAUDE = { Atlas: "claude/sonnet" };

let sent = 0;
const submit = (h: Harness, message: string, mode: "followUp" | "steer" = "followUp", bot = h.bot) =>
  h.run(h.daemon.submit(bot, `claude-${++sent}`, message, mode, null));
async function ask(h: Harness, message: string, bot = h.bot) {
  await submit(h, message, "followUp", bot);
  await until(`an answer to "${message}"`, async () => (await idle(h, bot)) && (await h.entries(bot)).at(-1)?.kind === "assistant", 10_000);
}
const answers = async (h: Harness) =>
  (await h.entries()).filter((e) => e.kind === "assistant").map((e) => (e.kind === "assistant" ? textOf(e.message.content) : ""));
const promptText = (fake: FakeClaude, index: number) => {
  const content = fake.prompts.at(index)?.message.content;
  return typeof content === "string" ? content : (content ?? []).map((b) => (b.type === "text" ? b.text : `[${b.type}]`)).join("\n");
};

/** A tool that runs until `release`, counting its runs. */
function gate(name: string, replay?: "safe") {
  const state = { runs: 0, release: () => {}, started: false };
  const tool: TopTool = {
    name,
    label: name,
    description: `The ${name} tool.`,
    parameters: Type.Object({ target: Type.String() }),
    ...(replay ? { replay } : {}),
    run: (args, ctx) =>
      fromPromise(
        () =>
          new Promise((resolve) => {
            state.runs++;
            state.started = true;
            state.release = () => resolve(text(`${name} ${String(args.target)}: ok`));
            ctx.signal?.addEventListener("abort", () => resolve({ ...text(`${name}: stopped`), isError: true }), { once: true });
          }),
      ),
  };
  return { tool, state };
}

const echo: TopTool = {
  name: "echo",
  label: "Echo",
  description: "Says its text back.",
  parameters: Type.Object({ text: Type.String() }),
  run: (args) => Effect.succeed(text(`echo: ${String(args.text)}`)),
};

test("a Claude bot answers through the Agent SDK, with Top's instructions, no built-in tools and no settings files, and keeps its session", async () => {
  const fake = fakeClaude();
  const made = await harness({ claude: fake, bots: [] });
  const id = await made.run(made.daemon.createBot("Atlas", "", 0, "claude/sonnet"));
  const h = { ...made, bot: id, entries: (bot = id) => made.entries(bot) };
  await h.run(h.daemon.start);
  await ask(h, "hello there");
  assert.deepEqual(await answers(h), ["Claude heard: hello there"]);
  const first = fake.launches[0]!;
  assert.deepEqual(first.tools, [], "Claude Code's own tools are off");
  assert.deepEqual(first.settingSources, [], "no settings, CLAUDE.md or skills from the computer");
  assert.equal(first.model, "sonnet");
  assert.match(String(first.systemPrompt), /You are one of the user's bots/);
  assert.equal(first.permissionMode, "default");
  const session = (await h.run(h.store.bot(h.bot)))!.session;
  assert.ok(session && first.sessionId === session, "the session id is saved before Claude Code starts");

  await ask(h, "and again");
  const second = fake.launches[1]!;
  assert.equal(second.resume, session, "the next message carries on the same session");
  assert.equal(second.sessionId, undefined);
  assert.deepEqual(await answers(h), ["Claude heard: hello there", "Claude heard: and again"]);
  assert.equal((await h.run(h.daemon.runner(h.bot))).status().status, "idle");
  const summary = h.daemon.bots().find((b) => b.id === h.bot)!;
  assert.equal(summary.model, "claude/sonnet");
});

test("Top's tools reach Claude over MCP with their JSON Schema, and run through Top's tool records", async () => {
  const fake = fakeClaude();
  const h = await harness({ claude: fake, models: CLAUDE, tools: [echo] });
  await h.run(h.daemon.start);
  await ask(h, 'call echo {"text":"ping"}');
  const entries = await h.entries();
  const callsOf = (e: (typeof entries)[number]) =>
    e.kind === "assistant" && Array.isArray(e.message.content) ? e.message.content.flatMap((p) => (p.type === "toolCall" ? [p] : [])) : [];
  const call = entries.find((e) => callsOf(e).length > 0);
  assert.ok(call);
  const part = callsOf(call)[0];
  assert.ok(part);
  assert.equal(part.name, "echo", "the call shows under Top's own tool name");
  const result = entries.find((e) => e.kind === "tool");
  assert.ok(result && result.kind === "tool");
  assert.equal(textOf(result.message.content), "echo: ping");
  assert.ok(await h.run(h.store.toolCall(call.seq, part.id)), "the call was recorded before it ran");
  assert.deepEqual((await answers(h)).at(-1), "echo said: echo: ping");

  const invalid = await (async () => {
    await ask(h, 'call echo {"nope":1}');
    const last = (await h.entries()).filter((e) => e.kind === "tool").at(-1);
    return last?.kind === "tool" ? last.message : undefined;
  })();
  assert.ok(invalid?.isError, "Top checks the arguments against the tool's schema");
});

test("a Claude bot never runs on an API key: the turn fails with how to sign in, and nothing is sent", async () => {
  const fake = fakeClaude();
  fake.account = { apiProvider: "firstParty", apiKeySource: "ANTHROPIC_API_KEY" };
  const h = await harness({ claude: fake, models: CLAUDE });
  await h.run(h.daemon.start);
  await submit(h, "hello");
  await until("failed", async () => (await h.run(h.daemon.runner(h.bot))).status().status === "failed" && (await idle(h)));
  const status = (await h.run(h.daemon.runner(h.bot))).status();
  assert.match(status.error ?? "", /API key/);
  assert.match(status.error ?? "", /sign in with your Claude account/);
  assert.equal(fake.prompts.length, 0, "Claude Code was given no message");

  assert.match(subscriptionProblem({}) ?? "", /isn't signed in with a Claude subscription/);
  assert.match(subscriptionProblem({ apiProvider: "bedrock", subscriptionType: "Claude Max" }) ?? "", /bedrock/);
  assert.equal(subscriptionProblem({ apiProvider: "firstParty", subscriptionType: "Claude Max" }), undefined);
});

test("a change to the bot's files reaches Claude with its next message, not before", async () => {
  const fake = fakeClaude();
  const h = await harness({ claude: fake, models: CLAUDE, context: true });
  const folder = join(h.dir, "bots", "Atlas");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "SOUL.md"), "# Atlas\nA careful helper.");
  await h.run(h.daemon.start);
  await ask(h, "first");
  assert.match(String(fake.launches[0]!.systemPrompt), /A careful helper/, "a new session's system prompt has the files");
  assert.doesNotMatch(promptText(fake, 0), /top-system-update/);

  writeFileSync(join(folder, "USER.md"), "The user likes short answers.");
  await ask(h, "second");
  const second = promptText(fake, 1);
  assert.match(second, /<top-system-update>[\s\S]*The user likes short answers[\s\S]*<\/top-system-update>/);
  assert.match(second, /second$/, "the update leads the user's message");

  await ask(h, "third");
  assert.doesNotMatch(promptText(fake, 2), /top-system-update/, "the same files, no update");
});

test("Stop interrupts Claude, cuts off the running tool and ends the turn", async () => {
  const fake = fakeClaude();
  const { tool, state } = gate("deploy");
  const h = await harness({ claude: fake, models: CLAUDE, tools: [tool] });
  await h.run(h.daemon.start);
  await submit(h, 'call deploy {"target":"web"}');
  await until("the tool running", () => state.started);
  await h.run(h.daemon.stop(h.bot));
  await until("idle", () => idle(h));
  const entries = await h.entries();
  const result = entries.find((e) => e.kind === "tool");
  assert.ok(result && result.kind === "tool" && result.message.isError, "the cut-off call has a result");
  assert.equal((await h.run(h.daemon.runner(h.bot))).status().status, "idle");
  assert.equal((await h.run(h.store.bot(h.bot)))!.runActive, false);
  state.release();
});

test("steering reaches Claude during the turn, as the next thing it reads", async () => {
  const fake = fakeClaude();
  const { tool, state } = gate("build");
  const h = await harness({ claude: fake, models: CLAUDE, tools: [tool] });
  await h.run(h.daemon.start);
  await submit(h, 'call build {"target":"app"}');
  await until("the tool running", () => state.started);
  await submit(h, "also tidy up", "steer");
  await until("the steer saved", async () => (await h.entries()).filter((e) => e.kind === "user").length === 2);
  state.release();
  await until("idle", async () => (await idle(h)) && (await answers(h)).length >= 3);
  assert.equal(fake.prompts[1]!.priority, "next");
  const users = (await h.entries()).filter((e) => e.kind === "user").map((e) => (e.kind === "user" ? textOf(e.message.content) : ""));
  assert.deepEqual(users, ['call build {"target":"app"}', "also tidy up"]);
  assert.equal(fake.launches.length, 1, "one launch took both");
});

test("after a restart cut a Claude turn short, Top settles the tool by its policy, never runs it again, and tells Claude what it recorded", async () => {
  const fake = fakeClaude();
  const { tool, state } = gate("deploy");
  const first = await harness({ claude: fake, models: CLAUDE, tools: [tool] });
  await first.run(first.daemon.start);
  await submit(first, 'call deploy {"target":"prod"}');
  await until("the tool running", () => state.started);
  await first.close();

  const again = await harness({ dir: first.dir, claude: fake, models: CLAUDE, tools: [tool] });
  await again.run(again.daemon.start);
  await until("idle", async () => (await idle(again)) && (await answers(again)).length >= 2);
  assert.equal(state.runs, 1, "deploy didn't run again");
  const result = (await again.entries()).find((e) => e.kind === "tool");
  assert.ok(result && result.kind === "tool");
  assert.equal(result.outcome, "interrupted");
  assert.equal(fake.launches.at(-1)!.resume, fake.launches[0]!.sessionId, "the same session carries on");
  const caughtUp = promptText(fake, -1);
  assert.match(caughtUp, /this is what Top recorded/);
  assert.match(caughtUp, /deploy \{"target":"prod"\} \(toolu_[^)]+\), error: Interrupted: the daemon restarted/);
});

test("a replay-safe tool cut off by a restart runs once more, and Claude gets its result", async () => {
  const fake = fakeClaude();
  const { tool, state } = gate("status", "safe");
  const first = await harness({ claude: fake, models: CLAUDE, tools: [tool] });
  await first.run(first.daemon.start);
  await submit(first, 'call status {"target":"db"}');
  await until("the tool running", () => state.started);
  await first.close();

  state.started = false;
  const again = await harness({ dir: first.dir, claude: fake, models: CLAUDE, tools: [tool] });
  const starting = again.run(again.daemon.start);
  await until("the replay running", () => state.started);
  state.release();
  await starting;
  await until("idle", async () => (await idle(again)) && (await answers(again)).length >= 2);
  assert.equal(state.runs, 2);
  assert.match(promptText(fake, -1), /status \{"target":"db"\} \(toolu_[^)]+\): status db: ok/);
});

test("a restart before Claude saved the user's message gives it the message again, and only then", async () => {
  const fake = fakeClaude();
  const session = "00000000-0000-4000-8000-000000000001";
  const message = { role: "user" as const, content: "hi", timestamp: 5 };
  const unsaved = catchUp([message], [], session);
  assert.deepEqual(unsaved.unsent, [message]);
  assert.equal(unsaved.note, undefined);
  const saved = catchUp([message], [{ type: "user", uuid: promptUuid(session, message), message: {} }], session);
  assert.deepEqual(saved.unsent, []);
  assert.match(saved.note ?? "", /Carry on where you left off/);
  assert.equal(promptUuid(session, message), promptUuid(session, { ...message }), "the same message, the same id");
  void fake;
});

test("--model keeps setting Top's bots, not Claude bots; a Claude bot can change its Claude model but not its runtime", async () => {
  const fake = fakeClaude();
  const h = await harness({ claude: fake, bots: ["Atlas", "Nova"], models: { Atlas: "claude/opus", Nova: "stale/model" } });
  await h.run(h.daemon.start);
  const [atlas, nova] = h.bots as [number, number];
  assert.equal((await h.run(h.store.bot(atlas)))!.model, "claude/opus", "a Claude bot keeps its model");
  assert.notEqual((await h.run(h.store.bot(nova)))!.model, "stale/model", "a Top bot follows the daemon's model");

  await h.run(h.daemon.setBotModel(atlas, "claude/haiku"));
  await ask(h, "hi", atlas);
  assert.equal(fake.launches.at(-1)!.model, "haiku");
  await assert.rejects(h.run(h.daemon.setBotModel(atlas, "fake/fake-model")), /Claude Code/);
  await assert.rejects(h.run(h.daemon.setBotModel(nova, "claude/opus")), /Top's own loop/);
  await assert.rejects(h.run(h.daemon.setBotModel(atlas, "claude/gpt-9")), /no model "gpt-9"/);

  const id = await h.run(h.daemon.createBot("Scout", "", 0, "claude/default"));
  assert.equal((await h.run(h.store.bot(id)))!.model, "claude/default");
  await ask(h, "hey", id);
  assert.equal(fake.launches.at(-1)!.model, undefined, "default leaves the model to Claude Code");
  const runtimes = await h.run(h.daemon.runtimes);
  assert.equal(runtimes.claude, true);
  assert.deepEqual(runtimes.claudeModels, ["default", "opus", "sonnet", "haiku"]);
});

test("without Claude Code, a Claude bot's message fails and says why, and new Claude bots are refused", async () => {
  const h = await harness({ models: CLAUDE });
  await h.run(h.daemon.start);
  await submit(h, "hello");
  await until("failed", async () => (await h.run(h.daemon.runner(h.bot))).status().status === "failed" && (await idle(h)));
  assert.match((await h.run(h.daemon.runner(h.bot))).status().error ?? "", /doesn't run/);
  await assert.rejects(h.run(h.daemon.createBot("Scout", "", 0, "claude/opus")), /doesn't run bots on Claude Code/);
});

test("older data opens with no session for each bot", async () => {
  const h = await harness();
  await h.close();
  const db = new DatabaseSync(join(h.dir, "top.sqlite"));
  db.exec("ALTER TABLE bots DROP COLUMN session; DELETE FROM effect_sql_migrations WHERE migration_id >= 10");
  db.close();
  const again = await harness({ dir: h.dir });
  assert.equal((await again.run(again.store.bot(again.bot)))!.session, null);
});
