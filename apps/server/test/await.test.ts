/**
 * Waiting on work: tool calls that outrun the time limit move to the background and report back by
 * message, wake-ups bring a bot's note back when due, and both survive what a restart does to them.
 */
import assert from "node:assert/strict";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import Type from "typebox";
import { test } from "vitest";
import { backgroundGroup, findTool } from "../src/collar/background.ts";
import { wakeGroup } from "../src/collar/wake.ts";
import { makeJobs } from "../src/jobs.ts";
import type { InboxRow, StoredEntry } from "../src/store.ts";
import { fromPromise, type TopTool, text } from "../src/tools.ts";
import { toWire } from "../src/wire.ts";
import { type Harness, harness, idle, until } from "./harness.ts";

const FOREGROUND_MS = 150;
/** How long Top's messages to an idle bot wait for others (see runner.ts): short, for quick tests. */
const GATHER_MS = 100;

/** A tool that runs until the test lets it finish, or its signal stops it. */
function slowTool() {
  let finish: (value: string) => void = () => {};
  let stopped = false;
  let started = 0;
  const tool: TopTool = {
    name: "slow__tool",
    label: "Slow",
    description: "Takes as long as the test wants.",
    parameters: Type.Object({}),
    run: (_args, ctx) =>
      fromPromise(
        () =>
          new Promise((resolve, reject) => {
            started++;
            finish = (value) => resolve(text(value));
            ctx.signal?.addEventListener("abort", () => {
              stopped = true;
              reject(new Error("Command aborted"));
            });
          }),
      ),
  };
  return {
    tool,
    finish: (value: string) => finish(value),
    get stopped() {
      return stopped;
    },
    get started() {
      return started;
    },
  };
}

const setup = (tools: TopTool[] = [], dir?: string) => harness({ tools, foregroundMs: FOREGROUND_MS, gatherMs: GATHER_MS, ...(dir ? { dir } : {}) });

const textOf = (entry: StoredEntry) => {
  const message = JSON.parse(entry.message) as { content?: string | { type: string; text?: string }[] };
  return typeof message.content === "string" ? message.content : (message.content ?? []).map((p) => p.text ?? "").join("");
};
const fromTop = async (h: Harness, source: "wake" | "job") => (await h.entries()).filter((e) => e.kind === "user" && e.source === source);
const lastIsAnswer = async (h: Harness) => (await h.entries()).at(-1)?.kind === "assistant" && (await idle(h));
const messagesFrom = (h: Harness, source: "wake" | "job") => async () => {
  const found = await fromTop(h, source);
  return found.length ? found : undefined;
};

test("a tool call that outruns the limit moves to the background, and its result comes back as a message", async () => {
  const slow = slowTool();
  const h = await setup([slow.tool]);
  const { store, daemon, bot } = h;
  await h.run(daemon.start);
  await h.run(daemon.submit(bot, "r1", "call slow__tool {}", "followUp", null));

  // The task isn't held up: the call returns "moved to the background" and the bot finishes its turn.
  const moved = await until("the call to move to the background", async () =>
    (await h.entries()).find((e) => e.kind === "tool" && textOf(e).includes("moved to the background as job")),
  );
  assert.match(textOf(moved), /job 1\b/);
  await until("the bot to go idle", () => idle(h));
  assert.equal(daemon.jobs.count(bot), 1);
  await until("the sidebar to show the job", () => daemon.bots()[0]!.background === 1);

  slow.finish("deployed in 4 minutes");
  const [message] = await until("the job's message", messagesFrom(h, "job"));
  assert.match(textOf(message!), /^\[Background job 1 finished\] slow__tool, after /);
  assert.match(textOf(message!), /deployed in 4 minutes/);
  assert.deepEqual(toWire(message!), {
    seq: message!.seq,
    bot,
    at: message!.at,
    kind: "user",
    text: textOf(message!),
    requestId: message!.requestId!,
    source: "job",
  });
  // The bot took it like any message and answered.
  await until("the answer to the job's message", () => lastIsAnswer(h));
  assert.equal(daemon.jobs.count(bot), 0);
  assert.equal((await h.run(store.job(1)))?.state, "finished");
  assert.equal(slow.started, 1, "the tool ran once");
});

test("a call that ends within the limit is an ordinary tool call", async () => {
  const quick: TopTool = { name: "quick__tool", label: "Quick", description: "", parameters: Type.Object({}), run: () => Effect.succeed(text("done quickly")) };
  const h = await setup([quick]);
  await h.run(h.daemon.start);
  await h.run(h.daemon.submit(h.bot, "r1", "call quick__tool {}", "followUp", null));
  await until("the answer", () => lastIsAnswer(h));
  const result = (await h.entries()).find((e) => e.kind === "tool")!;
  assert.equal(textOf(result), "done quickly");
  assert.equal(await h.run(h.store.job(1)), undefined);
});

test("Stop ends the bot's background jobs, without a message about them", async () => {
  const slow = slowTool();
  const h = await setup([slow.tool]);
  const { daemon, bot } = h;
  await h.run(daemon.start);
  await h.run(daemon.submit(bot, "r1", "call slow__tool {}", "followUp", null));
  await until("the job", async () => daemon.jobs.count(bot) === 1 && (await idle(h)));
  await h.run(daemon.stop(bot));
  await until("the job to stop", () => daemon.jobs.count(bot) === 0);
  assert.equal(slow.stopped, true);
  assert.equal((await h.run(h.store.job(1)))?.state, "stopped");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(await fromTop(h, "job"), []);
});

test("waiting for a job takes its result, and then no message is sent about it", async () => {
  const h = await setup();
  const delivered: InboxRow[] = [];
  // Jobs on their own, in a scope that lasts the test.
  const scope = await h.run(Scope.make());
  const jobs = await h.run(
    makeJobs(
      {
        deliver: (row) =>
          Effect.sync(() => {
            delivered.push(row);
          }),
        changed: () => Effect.void,
      },
      50,
    ).pipe(Scope.provide(scope)),
  );
  const slow = slowTool();
  const result = await h.run(jobs.wrap(slow.tool).run({}, { key: "k1", bot: h.bot }));
  assert.match((result.content[0] as { text: string }).text, /job 1\b/);

  assert.equal(await h.run(jobs.wait(1, 30)), undefined, "still running");
  const waiting = h.run(jobs.wait(1, 5_000));
  slow.finish("all green");
  const outcome = await waiting;
  assert.ok(outcome?.ok);
  assert.equal((outcome.result.content[0] as { text: string }).text, "all green");
  assert.equal((await h.run(h.store.job(1)))?.state, "finished");
  assert.deepEqual(delivered, [], "the result went to the wait");
});

test("a job cut off by a restart is reported to its bot when the daemon starts again", async () => {
  const first = await setup();
  const { dir, bot } = first;
  const job = await first.run(first.store.startJob(bot, "1:2:call_x", "bash", "command: npm test", "", Date.now() - 90_000));
  await first.close();

  // A new daemon on the same data: the old process (and the job in it) is gone.
  const h = await setup([], dir);
  await h.run(h.daemon.start);
  const [message] = await until("the cut-off message", messagesFrom(h, "job"));
  assert.match(textOf(message!), new RegExp(`^\\[Background job ${job} was cut off\\] bash \\(command: npm test\\)`));
  assert.match(textOf(message!), /may even still be running/);
  assert.equal((await h.run(h.store.job(job)))?.state, "lost");
  await until("the bot to answer it", () => lastIsAnswer(h));
});

test("a wake-up the bot sets brings its note back when due", async () => {
  const h = await setup();
  await h.run(h.daemon.start);
  await h.run(h.daemon.submit(h.bot, "r1", 'call collar__wake {"in_minutes": 0.005, "note": "check the deploy"}', "followUp", null));
  const set = await until("the wake-up to be set", async () => (await h.entries()).find((e) => e.kind === "tool" && textOf(e).startsWith("Wake-up 1 set for")));
  assert.ok(set);
  const [message] = await until("the wake-up", messagesFrom(h, "wake"));
  assert.match(textOf(message!), /^\[Wake-up\] check the deploy\n/);
  assert.doesNotMatch(textOf(message!), /late/);
  assert.deepEqual(await h.run(h.store.wakes(h.bot)), []);
  await until("the bot to answer it", () => lastIsAnswer(h));
  assert.equal((await fromTop(h, "wake")).length, 1, "it went off once");
});

test("a wake-up that came due while the daemon was down goes off when it starts, saying how late", async () => {
  const first = await setup();
  const { dir, bot } = first;
  await first.run(first.store.addWake(bot, "k-late", Date.now() - 3 * 60 * 60_000, "send the weekly report"));
  await first.run(first.store.addWake(bot, "k-later", Date.now() + 60 * 60_000, "not yet"));
  await first.close();

  const h = await setup([], dir);
  assert.equal(h.daemon.bots()[0]!.wakeAt, (await h.run(h.store.wakes(bot)))[0]!.dueAt);
  await h.run(h.daemon.start);
  const [message] = await until("the late wake-up", messagesFrom(h, "wake"));
  assert.match(textOf(message!), /^\[Wake-up\] send the weekly report/);
  assert.match(textOf(message!), /3h late: the daemon wasn't running/);
  assert.deepEqual(
    (await h.run(h.store.wakes(bot))).map((w) => w.note),
    ["not yet"],
  );
  await until("the bot to answer it", () => lastIsAnswer(h));
});

test("wake-ups can be listed and cancelled, and setting one twice from the same call sets one", async () => {
  const h = await setup();
  const wake = wakeGroup(collarOf(h))[0]!;
  const run = (args: Record<string, unknown>, key = "k") => h.run(wake.run(args, { key, bot: h.bot })).then((r) => (r.content[0] as { text: string }).text);
  assert.match(await run({ in_minutes: 30, note: "first" }, "a"), /^Wake-up 1 set for/);
  assert.match(await run({ in_minutes: 30, note: "first" }, "a"), /^Wake-up 1 set for/, "a replayed call sets nothing new");
  assert.match(await run({ at: "2000-01-01T00:00", note: "past" }), /has passed/);
  assert.match(await run({ note: "when?" }), /Say when/);
  assert.match(await run({ action: "list" }), /- 1: .*: first/);
  assert.equal(await run({ action: "cancel", id: 1 }), "Cancelled wake-up 1.");
  assert.equal(await run({ action: "cancel", id: 1 }), "You have no wake-up 1 waiting.");
  assert.deepEqual(await h.run(h.store.wakes(h.bot)), []);
});

// ── collar__background: the bot runs a tool as a job on purpose ──────────────────

type Result = Effect.Success<ReturnType<TopTool["run"]>>;
const resultText = (result: Result) => (result.content[0] as { text: string }).text;
/** What Collar's tools reach in the test's daemon. */
const collarOf = (h: Harness) => ({ store: h.store, jobs: h.daemon.jobs, wakes: h.daemon.wakes, changed: h.daemon.changed, toolsOf: h.daemon.toolsOf });
const backgroundOf = (h: Harness) => {
  const tool = backgroundGroup(collarOf(h))[0]!;
  return (args: Record<string, unknown>, key = "k") => h.run(tool.run(args, { key, bot: h.bot }));
};

test("a bot can start a tool in the background at once, and hears back by message, under its note", async () => {
  const slow = slowTool();
  const h = await setup([slow.tool]);
  await h.run(h.daemon.start);
  await h.run(h.daemon.submit(h.bot, "r1", 'call collar__background {"tool": "slow__tool", "note": "review of PR 12"}', "followUp", null));
  const started = await until("the job to start", async () =>
    (await h.entries()).find((e) => e.kind === "tool" && textOf(e).startsWith("Started as background job 1")),
  );
  assert.ok(started);
  await until("the bot to go idle", () => idle(h));
  // It didn't wait for the time limit: the job is listed with its note.
  assert.deepEqual(
    h.daemon.jobs.running(h.bot).map((j) => [j.id, j.tool, j.note]),
    [[1, "slow__tool", "review of PR 12"]],
  );

  slow.finish("LGTM, two nits");
  const [message] = await until("the job's message", messagesFrom(h, "job"));
  assert.match(textOf(message!), /^\[Background job 1 finished\] review of PR 12: slow__tool, after /);
  assert.match(textOf(message!), /LGTM, two nits/);
  await until("the answer", () => lastIsAnswer(h));
});

test("several jobs run at once and each reports back", async () => {
  const a = slowTool();
  const second = slowTool();
  const h = await setup([a.tool, { ...second.tool, name: "other__tool" }]);
  await h.run(h.daemon.start);
  const background = backgroundOf(h);
  assert.match(resultText(await background({ tool: "slow__tool", note: "first" }, "k1")), /^Started as background job 1/);
  assert.match(resultText(await background({ tool: "other__tool", note: "second" }, "k2")), /^Started as background job 2/);
  assert.equal(h.daemon.jobs.count(h.bot), 2);
  second.finish("second done");
  a.finish("first done");
  const texts = await until("both messages", async () => {
    const found = (await fromTop(h, "job")).map((e) => textOf(e).split("\n")[0]!);
    return found.length === 2 ? found.sort() : undefined;
  });
  assert.match(texts[0]!, /^\[Background job 1 finished\] first: slow__tool/);
  assert.match(texts[1]!, /^\[Background job 2 finished\] second: other__tool/);
  await until("the bot to answer", () => lastIsAnswer(h));
});

test("with wait_seconds, a call that ends in time is an ordinary result", async () => {
  const soon: TopTool = {
    name: "soon__tool",
    label: "Soon",
    description: "",
    parameters: Type.Object({ value: Type.String() }),
    run: (args) => Effect.as(Effect.sleep("50 millis"), text(`got ${String(args.value)}`)),
  };
  const h = await setup([soon]);
  const background = backgroundOf(h);
  assert.equal(resultText(await background({ tool: "soon__tool", arguments: { value: "x" }, wait_seconds: 5 })), "got x");
  assert.equal(h.daemon.jobs.count(h.bot), 0);
  // Started straight in the background, a call this quick still answers: it gets a second to fail or end.
  assert.equal(resultText(await background({ tool: "soon__tool", arguments: { value: "y" } }, "k2")), "got y");
  assert.equal(h.daemon.jobs.count(h.bot), 0);
});

test("stop_after_minutes stops a job that runs too long, and the bot is told it timed out", async () => {
  const slow = slowTool();
  const h = await setup([slow.tool]);
  const started = resultText(await backgroundOf(h)({ tool: "slow__tool", stop_after_minutes: 0.025, note: "flaky agent" }));
  assert.match(started, /It will be stopped if it's still running 2s after it started/);
  const [message] = await until("the timeout message", messagesFrom(h, "job"));
  assert.match(textOf(message!), /^\[Background job 1 timed out\] flaky agent: slow__tool: stopped after/);
  assert.match(textOf(message!), /Command aborted/, "with what the job came to");
  await until("the bot to answer", () => lastIsAnswer(h));
  assert.equal(slow.stopped, true);
  assert.equal((await h.run(h.store.job(1)))?.state, "stopped");
});

test("background checks the tool and its arguments before starting anything", async () => {
  const strict: TopTool = {
    name: "strict__tool",
    label: "",
    description: "",
    parameters: Type.Object({ n: Type.Number() }),
    run: () => Effect.succeed(text("ran")),
  };
  const h = await setup([strict]);
  const run = backgroundOf(h);
  const unknown = await run({ tool: "nope__tool" });
  assert.equal(unknown.isError, true);
  assert.match(resultText(unknown), /no tool named "nope__tool"/);
  const invalid = await run({ tool: "strict__tool", arguments: { n: "not a number" } });
  assert.equal(invalid.isError, true);
  assert.match(resultText(invalid), /Validation failed/);
  const near = await run({ tool: "strict" });
  assert.match(resultText(near), /Did you mean "strict__tool"\?/);
  const waiting = await run({ tool: "collar__jobs", arguments: { action: "list" } });
  assert.match(resultText(waiting), /can't run in the background/);
  assert.match(resultText(await run({ tool: "strict__tool", arguments: { n: "3" }, wait_seconds: 1 })), /^ran$/, "coerced like a direct call");
  assert.equal(h.daemon.jobs.count(h.bot), 0);
});

test("jobs that end together while the bot is idle reach it in one task", async () => {
  const a = slowTool();
  const b = slowTool();
  const h = await setup([a.tool, { ...b.tool, name: "other__tool" }]);
  await h.run(h.daemon.start);
  const background = backgroundOf(h);
  await background({ tool: "slow__tool" }, "k1");
  await background({ tool: "other__tool" }, "k2");
  assert.equal(h.daemon.jobs.count(h.bot), 2);

  // A moment apart, as two agents finish: the first doesn't start a task of its own.
  a.finish("first done");
  await new Promise((resolve) => setTimeout(resolve, GATHER_MS / 2));
  b.finish("second done");
  await until("the bot to answer", () => lastIsAnswer(h));
  const kinds = (await h.entries()).filter((e) => e.kind === "user" || e.kind === "assistant").map((e) => (e.kind === "user" ? e.source : e.kind));
  assert.deepEqual(kinds, ["job", "job", "assistant"], "both messages first, then one answer");
});

test("a job that ends while the bot is busy reaches it at its next step, not when the task ends", async () => {
  const slow = slowTool();
  let release: () => void = () => {};
  const hold: TopTool = {
    name: "hold__tool",
    label: "Hold",
    description: "Runs until the test lets it go.",
    parameters: Type.Object({}),
    background: false,
    run: () => fromPromise(() => new Promise((resolve) => (release = () => resolve(text("held"))))),
  };
  const h = await setup([slow.tool, hold]);
  await h.run(h.daemon.start);
  await backgroundOf(h)({ tool: "slow__tool" }, "k1");

  await h.run(h.daemon.submit(h.bot, "r1", "call hold__tool {}", "followUp", null));
  await until("the bot to be in its tool call", async () => (await h.run(h.daemon.runner(h.bot))).status().tool === "hold__tool");
  slow.finish("agent 2 done");
  await new Promise((resolve) => setTimeout(resolve, 50));
  release();
  await until("the bot to answer", () => lastIsAnswer(h));

  const kinds = (await h.entries()).map((e) => (e.kind === "user" ? (e.source ?? "user") : e.kind));
  const held = kinds.indexOf("tool");
  assert.deepEqual(kinds.slice(held, held + 3), ["tool", "job", "assistant"], "the job's message right after the tool result, in the same task");
  assert.equal(kinds.filter((k) => k === "assistant").length, 2, "one answer after the message, not a second task");
});

test("background finds the tool a bot means, even named the way its model sees it", () => {
  const tools = [{ name: "bash" }, { name: "t3code__t3_thread_wait" }, { name: "github__create_issue" }, { name: "gitlab__create_issue" }];
  const found = (name: string) => {
    const result = findTool(tools, name);
    return "tool" in result ? result.tool.name : result.error;
  };
  assert.equal(found("functions.t3code__t3_thread_wait"), "t3code__t3_thread_wait", "a namespace in front");
  assert.equal(found("multi_tool_use.bash"), "bash");
  assert.equal(found("T3code__T3_Thread_Wait"), "t3code__t3_thread_wait", "the wrong case");
  assert.equal(found("t3_thread_wait"), "t3code__t3_thread_wait", "without its server");
  assert.match(found("create_issue"), /could be "github__create_issue" or "gitlab__create_issue"/, "never a guess between two");
  assert.match(found("thread_wait"), /no tool named "thread_wait"\. Did you mean "t3code__t3_thread_wait"\?/);
  assert.match(found("deploy"), /no tool named "deploy"\. Use a name exactly/);
});

test("a daemon that shuts down mid-call stops the tool, and saves nothing after", async () => {
  const slow = slowTool();
  const h = await harness({ tools: [slow.tool], foregroundMs: 60_000 });
  await h.run(h.daemon.start);
  await h.run(h.daemon.submit(h.bot, "r1", "call slow__tool {}", "followUp", null));
  await until("the call to start", () => slow.started === 1);
  const before = (await h.entries()).length;
  await h.close();
  assert.equal(slow.stopped, true, "the tool's signal fired");

  const again = await harness({ tools: [slow.tool], foregroundMs: 60_000, dir: h.dir });
  const after = await again.entries();
  assert.ok(after.length <= before + 1, "at most the run's end, no further steps");
  assert.equal(slow.started, 1, "the call wasn't run again");
});

test("Stop right after a message, before its run gets going, still stops it", async () => {
  const slow = slowTool();
  const h = await setup([slow.tool]);
  await h.run(h.daemon.start);
  await h.run(Effect.andThen(h.daemon.submit(h.bot, "r1", "call slow__tool {}", "followUp", null), h.daemon.stop(h.bot)));
  await until("the bot to go idle", () => idle(h));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(slow.started, 0, "the tool never ran");
});
