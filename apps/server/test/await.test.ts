/**
 * Waiting on work: tool calls that outrun the time limit move to the background and report back by
 * message, wake-ups bring a bot's note back when due, and both survive what a restart does to them.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import Type from "typebox";
import { backgroundGroup, findTool } from "../src/collar/background.ts";
import { wakeGroup } from "../src/collar/wake.ts";
import { Daemon } from "../src/daemon.ts";
import { createFakeModelProvider, FAKE_MODEL, FAKE_PROVIDER } from "../src/fake-bots.ts";
import { Jobs } from "../src/jobs.ts";
import { type InboxRow, Store, type StoredEntry } from "../src/store.ts";
import { type TopTool, text } from "../src/tools.ts";
import { toWire } from "../src/wire.ts";

const cleanup: (() => Promise<void> | void)[] = [];
after(async () => {
  for (const fn of cleanup.reverse()) await fn();
});

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
      new Promise((resolve, reject) => {
        started++;
        finish = (value) => resolve(text(value));
        ctx.signal?.addEventListener("abort", () => {
          stopped = true;
          reject(new Error("Command aborted"));
        });
      }),
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

function setup(tools: TopTool[] = [], existing?: { dir: string; store: Store }) {
  const dir = existing?.dir ?? mkdtempSync(join(tmpdir(), "top-await-"));
  const store = existing?.store ?? new Store(join(dir, "top.sqlite"));
  if (!existing) {
    store.createBot("Atlas", "", `${FAKE_PROVIDER}/${FAKE_MODEL}`);
    cleanup.push(() => {
      try {
        store.close();
      } catch {
        // closed already
      }
      rmSync(dir, { recursive: true, force: true });
    });
  }
  const models = createModels();
  models.setProvider(createFakeModelProvider(2_000).provider);
  const daemon = new Daemon(store, models, tools, { foregroundMs: FOREGROUND_MS, gatherMs: GATHER_MS });
  cleanup.push(() => daemon.close());
  const bot = store.bots()[0]!.id;
  return { dir, store, daemon, bot };
}

async function until<T>(what: string, check: () => T | undefined | false, timeoutMs = 5_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const entries = (store: Store, bot: number): StoredEntry[] => store.after(bot, 0, 1_000);
const textOf = (entry: StoredEntry) => {
  const message = JSON.parse(entry.message) as { content?: string | { type: string; text?: string }[] };
  return typeof message.content === "string" ? message.content : (message.content ?? []).map((p) => p.text ?? "").join("");
};
const fromTop = (store: Store, bot: number, source: "wake" | "job") => entries(store, bot).filter((e) => e.kind === "user" && e.source === source);
const idle = (daemon: Daemon, bot: number) => !daemon.runner(bot).busy && daemon.store.inbox(bot).length === 0;

test("a tool call that outruns the limit moves to the background, and its result comes back as a message", async () => {
  const slow = slowTool();
  const { store, daemon, bot } = setup([slow.tool]);
  await daemon.start();
  daemon.submit(bot, "r1", "call slow__tool {}", "followUp", null);

  // The task isn't held up: the call returns "moved to the background" and the bot finishes its turn.
  const moved = await until("the call to move to the background", () =>
    entries(store, bot).find((e) => e.kind === "tool" && textOf(e).includes("moved to the background as job")),
  );
  assert.match(textOf(moved), /job 1\b/);
  await until("the bot to go idle", () => idle(daemon, bot));
  assert.equal(daemon.jobs.count(bot), 1);
  await until("the sidebar to show the job", () => daemon.bots[0]!.background === 1);

  slow.finish("deployed in 4 minutes");
  const [message] = await until("the job's message", () => {
    const found = fromTop(store, bot, "job");
    return found.length ? found : undefined;
  });
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
  await until("the answer to the job's message", () => entries(store, bot).at(-1)?.kind === "assistant" && idle(daemon, bot));
  assert.equal(daemon.jobs.count(bot), 0);
  assert.equal(store.job(1)?.state, "finished");
  assert.equal(slow.started, 1, "the tool ran once");
});

test("a call that ends within the limit is an ordinary tool call", async () => {
  const quick: TopTool = { name: "quick__tool", label: "Quick", description: "", parameters: Type.Object({}), run: async () => text("done quickly") };
  const { store, daemon, bot } = setup([quick]);
  await daemon.start();
  daemon.submit(bot, "r1", "call quick__tool {}", "followUp", null);
  await until("the answer", () => entries(store, bot).at(-1)?.kind === "assistant" && idle(daemon, bot));
  const result = entries(store, bot).find((e) => e.kind === "tool")!;
  assert.equal(textOf(result), "done quickly");
  assert.equal(store.job(1), undefined);
});

test("Stop ends the bot's background jobs, without a message about them", async () => {
  const slow = slowTool();
  const { store, daemon, bot } = setup([slow.tool]);
  await daemon.start();
  daemon.submit(bot, "r1", "call slow__tool {}", "followUp", null);
  await until("the job", () => daemon.jobs.count(bot) === 1 && idle(daemon, bot));
  daemon.stop(bot);
  await until("the job to stop", () => daemon.jobs.count(bot) === 0);
  assert.equal(slow.stopped, true);
  assert.equal(store.job(1)?.state, "stopped");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(fromTop(store, bot, "job"), []);
});

test("waiting for a job takes its result, and then no message is sent about it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "top-await-"));
  const store = new Store(join(dir, "top.sqlite"));
  const bot = store.createBot("Atlas", "", "fake/model");
  cleanup.push(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const delivered: InboxRow[] = [];
  const jobs = new Jobs(store, { deliver: (row) => delivered.push(row), changed: () => {} }, 50);
  const slow = slowTool();
  const result = await jobs.wrap(slow.tool).run({}, { key: "k1", bot });
  assert.match((result.content[0] as { text: string }).text, /job 1\b/);

  assert.equal(await jobs.wait(1, 30), undefined, "still running");
  const waiting = jobs.wait(1, 5_000);
  slow.finish("all green");
  const outcome = await waiting;
  assert.ok(outcome?.ok);
  assert.equal((outcome.result.content[0] as { text: string }).text, "all green");
  assert.equal(store.job(1)?.state, "finished");
  assert.deepEqual(delivered, [], "the result went to the wait");
});

test("a job cut off by a restart is reported to its bot when the daemon starts again", async () => {
  const first = setup();
  const { store, dir, bot } = first;
  const job = store.startJob(bot, "1:2:call_x", "bash", "command: npm test", "", Date.now() - 90_000);
  first.daemon.close();

  // A new daemon on the same data: the old process (and the job in it) is gone.
  const { daemon } = setup([], { dir, store });
  await daemon.start();
  const [message] = await until("the cut-off message", () => {
    const found = fromTop(store, bot, "job");
    return found.length ? found : undefined;
  });
  assert.match(textOf(message!), new RegExp(`^\\[Background job ${job} was cut off\\] bash \\(command: npm test\\)`));
  assert.match(textOf(message!), /may even still be running/);
  assert.equal(store.job(job)?.state, "lost");
  await until("the bot to answer it", () => entries(store, bot).at(-1)?.kind === "assistant" && idle(daemon, bot));
});

test("a wake-up the bot sets brings its note back when due", async () => {
  const { store, daemon, bot } = setup();
  await daemon.start();
  daemon.submit(bot, "r1", 'call collar__wake {"in_minutes": 0.005, "note": "check the deploy"}', "followUp", null);
  const set = await until("the wake-up to be set", () => entries(store, bot).find((e) => e.kind === "tool" && textOf(e).startsWith("Wake-up 1 set for")));
  assert.ok(set);
  const [message] = await until("the wake-up", () => {
    const found = fromTop(store, bot, "wake");
    return found.length ? found : undefined;
  });
  assert.match(textOf(message!), /^\[Wake-up\] check the deploy\n/);
  assert.doesNotMatch(textOf(message!), /late/);
  assert.deepEqual(store.wakes(bot), []);
  await until("the bot to answer it", () => entries(store, bot).at(-1)?.kind === "assistant" && idle(daemon, bot));
  assert.equal(fromTop(store, bot, "wake").length, 1, "it went off once");
});

test("a wake-up that came due while the daemon was down goes off when it starts, saying how late", async () => {
  const first = setup();
  const { store, dir, bot } = first;
  store.addWake(bot, "k-late", Date.now() - 3 * 60 * 60_000, "send the weekly report");
  store.addWake(bot, "k-later", Date.now() + 60 * 60_000, "not yet");
  first.daemon.close();

  const { daemon } = setup([], { dir, store });
  assert.equal(daemon.bots[0]!.wakeAt, store.wakes(bot)[0]!.dueAt);
  await daemon.start();
  const [message] = await until("the late wake-up", () => {
    const found = fromTop(store, bot, "wake");
    return found.length ? found : undefined;
  });
  assert.match(textOf(message!), /^\[Wake-up\] send the weekly report/);
  assert.match(textOf(message!), /3h late: the daemon wasn't running/);
  assert.deepEqual(
    store.wakes(bot).map((w) => w.note),
    ["not yet"],
  );
  await until("the bot to answer it", () => entries(store, bot).at(-1)?.kind === "assistant" && idle(daemon, bot));
});

test("wake-ups can be listed and cancelled, and setting one twice from the same call sets one", async () => {
  const { store, daemon, bot } = setup();
  const wake = wakeGroup(daemon)[0]!;
  const run = (args: Record<string, unknown>, key = "k") => wake.run(args, { key, bot }).then((r) => (r.content[0] as { text: string }).text);
  assert.match(await run({ in_minutes: 30, note: "first" }, "a"), /^Wake-up 1 set for/);
  assert.match(await run({ in_minutes: 30, note: "first" }, "a"), /^Wake-up 1 set for/, "a replayed call sets nothing new");
  assert.match(await run({ at: "2000-01-01T00:00", note: "past" }), /has passed/);
  assert.match(await run({ note: "when?" }), /Say when/);
  assert.match(await run({ action: "list" }), /- 1: .*: first/);
  assert.equal(await run({ action: "cancel", id: 1 }), "Cancelled wake-up 1.");
  assert.equal(await run({ action: "cancel", id: 1 }), "You have no wake-up 1 waiting.");
  assert.deepEqual(store.wakes(bot), []);
});

// ── collar__background: the bot runs a tool as a job on purpose ──────────────────

const resultText = (result: Awaited<ReturnType<TopTool["run"]>>) => (result.content[0] as { text: string }).text;

test("a bot can start a tool in the background at once, and hears back by message, under its note", async () => {
  const slow = slowTool();
  const { store, daemon, bot } = setup([slow.tool]);
  await daemon.start();
  daemon.submit(bot, "r1", 'call collar__background {"tool": "slow__tool", "note": "review of PR 12"}', "followUp", null);
  const started = await until("the job to start", () =>
    entries(store, bot).find((e) => e.kind === "tool" && textOf(e).startsWith("Started as background job 1")),
  );
  assert.ok(started);
  await until("the bot to go idle", () => idle(daemon, bot));
  // It didn't wait for the time limit: the job is listed with its note.
  assert.deepEqual(
    daemon.jobs.running(bot).map((j) => [j.id, j.tool, j.note]),
    [[1, "slow__tool", "review of PR 12"]],
  );

  slow.finish("LGTM, two nits");
  const [message] = await until("the job's message", () => {
    const found = fromTop(store, bot, "job");
    return found.length ? found : undefined;
  });
  assert.match(textOf(message!), /^\[Background job 1 finished\] review of PR 12: slow__tool, after /);
  assert.match(textOf(message!), /LGTM, two nits/);
  await until("the answer", () => entries(store, bot).at(-1)?.kind === "assistant" && idle(daemon, bot));
});

test("several jobs run at once and each reports back", async () => {
  const a = slowTool();
  const second = slowTool();
  const tools = [a.tool, { ...second.tool, name: "other__tool" }];
  const { store, daemon, bot } = setup(tools);
  await daemon.start();
  const background = backgroundGroup(daemon)[0]!;
  assert.match(resultText(await background.run({ tool: "slow__tool", note: "first" }, { key: "k1", bot })), /^Started as background job 1/);
  assert.match(resultText(await background.run({ tool: "other__tool", note: "second" }, { key: "k2", bot })), /^Started as background job 2/);
  assert.equal(daemon.jobs.count(bot), 2);
  second.finish("second done");
  a.finish("first done");
  const texts = await until("both messages", () => {
    const found = fromTop(store, bot, "job").map((e) => textOf(e).split("\n")[0]!);
    return found.length === 2 ? found.sort() : undefined;
  });
  assert.match(texts[0]!, /^\[Background job 1 finished\] first: slow__tool/);
  assert.match(texts[1]!, /^\[Background job 2 finished\] second: other__tool/);
  await until("the bot to answer", () => entries(store, bot).at(-1)?.kind === "assistant" && idle(daemon, bot));
});

test("with wait_seconds, a call that ends in time is an ordinary result", async () => {
  const soon: TopTool = {
    name: "soon__tool",
    label: "Soon",
    description: "",
    parameters: Type.Object({ value: Type.String() }),
    run: (args) => new Promise((resolve) => setTimeout(() => resolve(text(`got ${String(args.value)}`)), 50)),
  };
  const { daemon, bot } = setup([soon]);
  const background = backgroundGroup(daemon)[0]!;
  assert.equal(resultText(await background.run({ tool: "soon__tool", arguments: { value: "x" }, wait_seconds: 5 }, { key: "k", bot })), "got x");
  assert.equal(daemon.jobs.count(bot), 0);
  // Started straight in the background, a call this quick still answers: it gets a second to fail or end.
  assert.equal(resultText(await background.run({ tool: "soon__tool", arguments: { value: "y" } }, { key: "k2", bot })), "got y");
  assert.equal(daemon.jobs.count(bot), 0);
});

test("stop_after_minutes stops a job that runs too long, and the bot is told it timed out", async () => {
  const slow = slowTool();
  const { store, daemon, bot } = setup([slow.tool]);
  const background = backgroundGroup(daemon)[0]!;
  const started = resultText(await background.run({ tool: "slow__tool", stop_after_minutes: 0.025, note: "flaky agent" }, { key: "k", bot }));
  assert.match(started, /It will be stopped if it's still running 2s after it started/);
  const [message] = await until("the timeout message", () => {
    const found = fromTop(store, bot, "job");
    return found.length ? found : undefined;
  });
  assert.match(textOf(message!), /^\[Background job 1 timed out\] flaky agent: slow__tool: stopped after/);
  assert.match(textOf(message!), /Command aborted/, "with what the job came to");
  await until("the bot to answer", () => entries(store, bot).at(-1)?.kind === "assistant" && idle(daemon, bot));
  assert.equal(slow.stopped, true);
  assert.equal(store.job(1)?.state, "stopped");
});

test("background checks the tool and its arguments before starting anything", async () => {
  const strict: TopTool = { name: "strict__tool", label: "", description: "", parameters: Type.Object({ n: Type.Number() }), run: async () => text("ran") };
  const { daemon, bot } = setup([strict]);
  const background = backgroundGroup(daemon)[0]!;
  const run = (args: Record<string, unknown>) => background.run(args, { key: "k", bot });
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
  assert.equal(daemon.jobs.count(bot), 0);
});

test("jobs that end together while the bot is idle reach it in one task", async () => {
  const a = slowTool();
  const b = slowTool();
  const { store, daemon, bot } = setup([a.tool, { ...b.tool, name: "other__tool" }]);
  await daemon.start();
  const background = backgroundGroup(daemon)[0]!;
  await background.run({ tool: "slow__tool" }, { key: "k1", bot });
  await background.run({ tool: "other__tool" }, { key: "k2", bot });
  assert.equal(daemon.jobs.count(bot), 2);

  // A moment apart, as two agents finish: the first doesn't start a task of its own.
  a.finish("first done");
  await new Promise((resolve) => setTimeout(resolve, GATHER_MS / 2));
  b.finish("second done");
  await until("the bot to answer", () => entries(store, bot).at(-1)?.kind === "assistant" && idle(daemon, bot));
  const kinds = entries(store, bot)
    .filter((e) => e.kind === "user" || e.kind === "assistant")
    .map((e) => (e.kind === "user" ? e.source : e.kind));
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
    run: () => new Promise((resolve) => (release = () => resolve(text("held")))),
  };
  const { store, daemon, bot } = setup([slow.tool, hold]);
  await daemon.start();
  await backgroundGroup(daemon)[0]!.run({ tool: "slow__tool" }, { key: "k1", bot });

  daemon.submit(bot, "r1", "call hold__tool {}", "followUp", null);
  await until("the bot to be in its tool call", () => daemon.runner(bot).status.tool === "hold__tool");
  slow.finish("agent 2 done");
  await new Promise((resolve) => setTimeout(resolve, 50));
  release();
  await until("the bot to answer", () => entries(store, bot).at(-1)?.kind === "assistant" && idle(daemon, bot));

  const kinds = entries(store, bot).map((e) => (e.kind === "user" ? (e.source ?? "user") : e.kind));
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
