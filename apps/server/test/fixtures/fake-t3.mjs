#!/usr/bin/env node
// A stand-in for T3 Code's `t3` CLI (0.1.12) as far as Top uses it: `thread start|send <…> - --wait`, `thread show --json`,
// `thread start --help` and `auth session issue|revoke`, printing what the real one prints. It never touches the network.
// FAKE_T3_DIR: a folder for its log (calls.jsonl) and the state it shares with the test's fake server: `running-<thread>`
// while a run waits, `stopped-<thread>` once the server took a Stop for it (a Stop on a thread with no run does nothing).
// FAKE_T3_SEND_DELAY_MS: how long `thread send` takes to reach T3 Code before its run starts.
// A message decides the run: "forever" runs until stopped, "question" waits for an answer, "fail" fails, "noproject"
// isn't in a project; anything else completes with "done: <message>".
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.FAKE_T3_DIR;
const args = process.argv.slice(2);
const log = (entry = {}) =>
  dir &&
  appendFileSync(join(dir, "calls.jsonl"), `${JSON.stringify({ args, cwd: process.cwd(), home: process.env.T3CODE_HOME, pid: process.pid, ...entry })}\n`);
const say = (text) => process.stderr.write(`${text}\n`);
const [group, command] = args;

if (group === "thread" && command === "start" && args.includes("--help")) {
  log();
  console.log("FLAGS\n  --wait    Wait for the agent to finish and print its reply.\n  --json    Print JSON instead of text.");
  process.exit(0);
}

if (group === "auth" && command === "session") {
  log();
  if (args[2] === "issue") console.log(JSON.stringify({ sessionId: "ses-fake", token: "t3-secret-token-abcdefghijklmnop", scopes: ["orchestration:operate"] }));
  else console.log(`Revoked session ${args[3]}.`);
  process.exit(0);
}

if (group === "thread" && command === "show") {
  log();
  const thread = args[2];
  const running = existsSync(join(dir, `running-${thread}`));
  console.log(
    JSON.stringify({
      thread: {
        threadId: thread,
        link: `https://app.t3.codes/threads/env-fake/${thread}`,
        status: running ? "running" : "idle",
        activeRunId: running ? `run:${thread}:1` : null,
      },
      messages: [],
    }),
  );
  process.exit(0);
}

if (group !== "thread" || (command !== "start" && command !== "send")) {
  say(`fake t3: unexpected ${args.join(" ")}`);
  process.exit(3);
}

const message = readFileSync(0, "utf8");
log({ message });
if (message.includes("noproject")) {
  say(`No T3 Code project matches '${args[2]}'. Pass a project id or a path inside a project.`);
  process.exit(1);
}
const thread = command === "start" ? (process.env.FAKE_T3_THREAD ?? "thr-1") : args[2];
// As the real one does with --wait and without --json: the thread's id first, on stderr.
if (command === "start") say(`Thread ${thread}`);

if (command === "send" && process.env.FAKE_T3_SEND_DELAY_MS) await new Promise((resolve) => setTimeout(resolve, Number(process.env.FAKE_T3_SEND_DELAY_MS)));
if (message.includes("forever")) {
  rmSync(join(dir, `stopped-${thread}`), { force: true });
  writeFileSync(join(dir, `running-${thread}`), "");
  const timer = setInterval(() => {
    if (!existsSync(join(dir, `stopped-${thread}`))) return;
    clearInterval(timer);
    rmSync(join(dir, `running-${thread}`), { force: true });
    say(`Thread ${thread} stopped with status interrupted.`);
    process.exit(1);
  }, 10);
} else if (message.includes("question")) {
  say(`Thread ${thread} is waiting for an answer. Open it in T3 Code to respond.`);
  process.exit(2);
} else if (message.includes("fail")) {
  say(`Thread ${thread} stopped with status failed: the provider broke`);
  process.exit(1);
} else {
  console.log(`done: ${message.trim()}`);
  process.exit(0);
}
