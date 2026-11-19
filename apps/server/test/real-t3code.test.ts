import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomInt, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "vitest";
import type { Tasks } from "../src/tasks/coordinator.ts";
import { describe as describeT3, exchangePairingCode, RpcSocket, writeT3Config } from "../src/tasks/t3api.ts";
import { T3CODE, t3codeAdapter } from "../src/tasks/t3code.ts";
import { type Harness, harness, until } from "./harness.ts";

// TOP_REAL_T3=/path/to/t3 boots an isolated T3 Code server (its own data folder, port and project, on
// 127.0.0.1 unless TOP_REAL_T3_HOST names another interface) and drives it through Top's task API with
// Claude Haiku. It uses the Claude Code sign-in on this computer (your plan), like real-harness.test.ts.
const binary = process.env.TOP_REAL_T3;
const bindHost = process.env.TOP_REAL_T3_HOST ?? "127.0.0.1";
const connectHost = process.env.TOP_REAL_T3_CONNECT_HOST ?? bindHost;
const model = process.env.TOP_REAL_T3_MODEL ?? "claude-haiku-5-5";

let server: ChildProcess | undefined;
const checkSessionScopes = async (origin: string, token: string) =>
  ((await (await fetch(`${origin}/api/auth/session`, { headers: { authorization: `Bearer ${token}` } })).json()) as { permissions?: string[] }).permissions;
afterAll(() => {
  server?.kill("SIGTERM");
});

test.skipIf(!binary)(
  "a real T3 Code server (TOP_REAL_T3=path/to/t3): pairs, runs, continues, asks, steers, queues, survives a Top restart and cancels",
  { timeout: 1_500_000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "top-real-t3-"));
    const base = join(dir, "t3");
    const project = join(dir, "project");
    mkdirSync(project);
    execFileSync("git", ["init", "-q"], { cwd: project });
    const port = randomInt(20_000, 40_000);
    server = spawn(binary!, ["serve", "--host", bindHost, "--port", String(port), "--base-dir", base, "--no-browser"], { stdio: "ignore" });
    const origin = `http://${connectHost}:${port}`;
    const descriptor = await until("T3 Code to answer", () => describeT3(origin).catch(() => undefined), 60_000);
    // The pairing code T3 Code makes; Top keeps only the session it trades it for.
    const pairing = JSON.parse(
      execFileSync(
        binary!,
        ["auth", "pairing", "create", "--base-dir", base, "--scope", "orchestration:read", "--scope", "orchestration:operate", "--label", "Top test", "--json"],
        { encoding: "utf8" },
      ),
    ) as { credential: string };
    const token = await exchangePairingCode(origin, pairing.credential, "Top test");
    assert.deepEqual(
      new Set((await checkSessionScopes(origin, token)) ?? []),
      new Set(["orchestration:read", "orchestration:operate"]),
      "Top's session holds exactly what it asked for",
    );
    await assert.rejects(exchangePairingCode(origin, pairing.credential, "again"), /didn't take that code/, "a code works once");

    const bogus = join(dir, "bogus.json");
    const config = {
      url: origin,
      environmentId: descriptor.environmentId,
      label: descriptor.label,
      serverVersion: descriptor.serverVersion,
      connectedAt: "now",
    };
    await writeT3Config(bogus, { ...config, token: "not-a-real-token-0000000000" });
    const refused = await t3codeAdapter({ file: bogus }).check();
    assert.equal(refused.ok, false);
    assert.match(refused.ok ? "" : refused.error, /no longer accepts Top's credential/, "an invalid credential is refused clearly");

    const file = join(dir, "t3code.json");
    await writeT3Config(file, { ...config, token });
    const rpc = await RpcSocket.open(origin, token, () => {});
    await rpc.request("projects.mutate", {
      type: "project.create",
      commandId: randomUUID(),
      projectId: randomUUID(),
      title: "top-real",
      workspaceRoot: project,
    });

    const adapter = t3codeAdapter({ file });
    const checked = await adapter.check();
    assert.equal(checked.ok, true, checked.ok ? "" : checked.error);
    const open = async () => {
      const h = await harness({ dir: join(dir, "top"), harnesses: [adapter], context: true, gatherMs: 10_000_000 });
      await h.run(h.daemon.start);
      return h;
    };
    mkdirSync(join(dir, "top"));
    let h: Harness = await open();
    const tasks = (): Tasks => h.daemon.tasks!;
    const start = (key: string, request: { prompt: string; session?: string }) =>
      h
        .run(
          tasks().start({
            bot: h.bot,
            key,
            ...(request.session ? {} : { harness: T3CODE, cwd: project, model, options: { provider: "claudeAgent" } }),
            ...request,
          }),
        )
        .then((r) => r.snapshot);
    const end = (id: string) => h.run(tasks().wait(h.bot, id, 300_000, "end")).then((r) => r.snapshot.task);
    const state = async (id: string) => (await h.run(tasks().snapshot(h.bot, id))).task.state;
    const running = (id: string) => until(`${id} running`, async () => (await state(id)) === "running", 180_000);
    const runsFor = async (threadId: string, messageId: string) => {
      const projection = (await rpc.request("orchestration.getThreadProjection", { threadId })) as { runs: { userMessageId: string; status: string }[] };
      return projection.runs.filter((r) => r.userMessageId === messageId);
    };

    const first = await start("t1", { prompt: "Create a file notes.txt here containing exactly: hello. Then reply with only DONE." });
    assert.equal(first.session.cwd, project, "the folder is T3 Code's project, not a folder on Top's side");
    const done = await end(first.task.id);
    assert.equal(done.state, "completed", done.error ?? "");
    assert.match(readFileSync(join(project, "notes.txt"), "utf8"), /^hello/);
    assert.match(done.result ?? "", /DONE/);
    const thread = (await h.run(h.store.tasks.session(first.session.id)))!.externalId!;
    assert.equal(thread, `top-${first.session.id}`);
    assert.equal((await runsFor(thread, `top:${first.task.id}`)).length, 1, "one run for the task's prompt");

    const second = await start("t2", {
      session: first.session.id,
      prompt: "What is the name of the file you created earlier in this conversation? Reply with only the file name.",
    });
    const remembered = await end(second.task.id);
    assert.equal(remembered.state, "completed", remembered.error ?? "");
    assert.match(remembered.result ?? "", /notes\.txt/, "the session carried on in the same T3 Code thread");

    const asking = await start("t3", {
      prompt:
        "Use your AskUserQuestion tool to ask me for a code word, offering the options alpha and beta. After I answer, reply with only the code word I gave.",
    });
    const asked = await h.run(tasks().wait(h.bot, asking.task.id, 300_000, "input_or_end"));
    const question = asked.snapshot.inputs[0];
    assert.ok(question, `T3 Code asked: ${asked.snapshot.task.state} ${asked.snapshot.task.error ?? ""}`);
    const word = `zephyr${randomInt(100_000, 999_999)}`;
    await h.run(tasks().respond("user", undefined, asking.task.id, question.id, { answers: { [question.questions[0]!.id]: [word] } }));
    const answered = await end(asking.task.id);
    assert.equal(answered.state, "completed", answered.error ?? "");
    assert.match(answered.result ?? "", new RegExp(word), "the typed answer reached the harness in T3 Code");

    const long = 'Run the shell command `node -e "setTimeout(() => {}, 25000)"` in the foreground, then reply with only FIRST.';
    const steering = await start("t4", { prompt: long });
    await running(steering.task.id);
    await until("the command to start", async () => (await h.run(tasks().read(h.bot, steering.task.id, 0, 200))).events.length > 2, 60_000).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    await h.run(tasks().send(h.bot, steering.task.id, "s1", "steer", "Change of plan: after the command, reply with only STEERED instead of FIRST."));
    await h.run(tasks().send(h.bot, steering.task.id, "s2", "queue", "Reply with only the word SECOND."));
    const steered = await end(steering.task.id);
    assert.equal(steered.state, "completed", steered.error ?? "");
    assert.match(steered.result ?? "", /SECOND/, "the queued message ran last");
    const steerEvents = await h.run(tasks().read(h.bot, steering.task.id, 0, 200));
    assert.ok(
      steerEvents.events.some((e) => e.kind === "message" && e.text.includes("STEERED")),
      "the steer changed the running turn",
    );

    // Top restarts while T3 Code works: the task is followed again, and nothing is sent twice.
    const surviving = await start("t5", { prompt: long });
    await running(surviving.task.id);
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    await h.close();
    h = await open();
    const survived = await end(surviving.task.id);
    assert.equal(survived.state, "completed", survived.error ?? "");
    assert.match(survived.result ?? "", /FIRST/);
    const survivedThread = `top-${surviving.session.id}`;
    assert.equal((await runsFor(survivedThread, `top:${surviving.task.id}`)).length, 1, "the restart didn't start the turn again");
    assert.ok((await h.run(tasks().read(h.bot, surviving.task.id, 0, 200))).events.some((e) => e.text.includes("following it again")));

    const cancelling = await start("t6", { prompt: long.replace("25000", "90000") });
    await running(cancelling.task.id);
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    const cancelled = await h.run(tasks().cancel(h.bot, cancelling.task.id));
    assert.equal(cancelled.task.state, "cancelled");
    const [cancelledRun] = await runsFor(`top-${cancelling.session.id}`, `top:${cancelling.task.id}`);
    assert.ok(cancelledRun && ["interrupted", "cancelled"].includes(cancelledRun.status), `T3 Code's run stopped too (${cancelledRun?.status})`);

    // Someone stops the run in T3 Code itself: the task ends, saying so, and only that run stopped.
    const stopped = await start("t7", { prompt: long.replace("25000", "90000") });
    await running(stopped.task.id);
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    const stoppedThread = `top-${stopped.session.id}`;
    const projection = (await rpc.request("orchestration.getThreadProjection", { threadId: stoppedThread })) as {
      runs: { id: string; userMessageId: string }[];
    };
    const runId = projection.runs.find((r) => r.userMessageId === `top:${stopped.task.id}`)!.id;
    await rpc.request("orchestration.dispatchCommand", { type: "run.interrupt", commandId: randomUUID(), threadId: stoppedThread, runId });
    const remote = await end(stopped.task.id);
    assert.equal(remote.state, "failed");
    assert.match(remote.error ?? "", /stopped in T3 Code/);
    assert.equal((await h.run(tasks().snapshot(h.bot, first.task.id))).task.state, "completed", "other tasks are untouched");

    rpc.close();
    await h.close();
    server.kill("SIGTERM");
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  },
);
