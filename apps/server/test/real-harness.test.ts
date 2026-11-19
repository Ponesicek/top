import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { test } from "vitest";
import { claudeAdapter } from "../src/tasks/claude.ts";
import { codexAdapter } from "../src/tasks/codex.ts";
import { botFolder } from "../src/workspace.ts";
import { harness, until } from "./harness.ts";

const which = process.env.TOP_REAL_HARNESS;

test.skipIf(which !== "codex" && which !== "claude_code")(
  "a real harness (TOP_REAL_HARNESS=codex or claude_code): runs, carries on its session, asks before leaving its sandbox, steers, queues and cancels",
  { timeout: 900_000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "top-real-"));
    const folder = botFolder(join(dir, "bots"), "Atlas");
    mkdirSync(folder, { recursive: true });
    const adapter = which === "codex" ? codexAdapter({ clientVersion: "test" }) : claudeAdapter({ clientVersion: "test" });
    const h = await harness({ dir, harnesses: [adapter], context: true, gatherMs: 10_000_000 });
    await h.run(h.daemon.start);
    const tasks = h.daemon.tasks!;
    const start = (key: string, request: { prompt: string; session?: string }) =>
      h.run(tasks.start({ bot: h.bot, key, ...(request.session ? {} : { harness: adapter.id }), ...request })).then((r) => r.snapshot);
    const end = (id: string) => h.run(tasks.wait(h.bot, id, 300_000, "end")).then((r) => r.snapshot.task);
    const running = (id: string) => until("running", async () => (await h.run(tasks.snapshot(h.bot, id))).task.state === "running", 120_000);

    const first = await start("r1", { prompt: "Create a file notes.txt here containing exactly: hello. Then reply with only DONE." });
    const done = await end(first.task.id);
    assert.equal(done.state, "completed", done.error ?? "");
    assert.match(readFileSync(join(folder, "notes.txt"), "utf8"), /^hello/);

    const outside = `/var/tmp/top-real-${Date.now()}.txt`;
    const second = await start("r2", {
      session: first.session.id,
      prompt: `Write the text x to ${outside} with a shell command. It is outside your sandbox: if it's blocked, request approval to run it outside the sandbox. If approval is declined, reply with only DECLINED.`,
    });
    const asked = await h.run(tasks.wait(h.bot, second.task.id, 300_000, "input_or_end"));
    const input = asked.snapshot.inputs[0];
    if (input) {
      assert.equal(input.spec.userOnly, true);
      const byBot = await h.run(Effect.result(tasks.respond("bot", h.bot, second.task.id, input.id, { decision: "allow" })));
      assert.equal(byBot._tag, "Failure", "the bot can't let a harness out of its sandbox");
      await h.run(tasks.respond("user", undefined, second.task.id, input.id, { decision: "deny" }));
    }
    assert.equal((await end(second.task.id)).state, "completed");
    assert.equal(existsSync(outside), false, "nothing was written outside the workspace");

    const third = await start("r3", { prompt: "Run the shell command `sleep 15`, then reply with only FIRST." });
    await running(third.task.id);
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    await h.run(tasks.send(h.bot, third.task.id, "s1", "steer", "Change of plan: after the sleep, reply with only STEERED instead of FIRST."));
    await h.run(tasks.send(h.bot, third.task.id, "s2", "queue", "Reply with only the word SECOND."));
    const steered = await end(third.task.id);
    assert.match(steered.result ?? "", /SECOND/, "the queued message ran last");
    const events = await h.run(tasks.read(h.bot, third.task.id, 0, 200));
    assert.ok(
      events.events.some((e) => e.kind === "message" && e.text.includes("STEERED")),
      "the steer changed the running turn",
    );

    const fourth = await start("r4", { prompt: "Run the shell command `sleep 90`, then reply DONE." });
    await running(fourth.task.id);
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    const cancelled = await h.run(tasks.cancel(h.bot, fourth.task.id));
    assert.equal(cancelled.task.state, "cancelled");
    await h.close();
  },
);
