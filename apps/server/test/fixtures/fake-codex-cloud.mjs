#!/usr/bin/env node
// A stand-in for `codex` (0.171.0) as far as `codex cloud` and `codex login status` go, printing what the real CLI prints
// (codex-rs/cloud-tasks/src/lib.rs, codex-rs/cli/src/login.rs at rust-v0.171.0). It never touches the network.
// FAKE_CC_DIR: a folder for its log (calls.jsonl) and state. FAKE_CC_LOGIN: chatgpt (default) | apikey | none.
// FAKE_CC_EXEC: ok (default) | notfound | http500 | hang | evil. FAKE_CC_STATES: comma-separated states `status` goes through.
// FAKE_CC_TITLE: the task's title. FAKE_CC_OLD: a CLI without `--attempts`.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.FAKE_CC_DIR;
const args = process.argv.slice(2);
const readStdin = () => (process.stdin.isTTY ? "" : readFileSync(0, "utf8"));
const log = (entry) => dir && appendFileSync(join(dir, "calls.jsonl"), `${JSON.stringify({ args, cwd: process.cwd(), ...entry })}\n`);
// Every `codex cloud` command keeps an error.log, with the account id, in the folder it runs in.
const errorLog = () => appendFileSync(join(process.cwd(), "error.log"), "auth: mode=ChatGPT account_id=acct_fake\n");

if (args[0] === "--version") {
  log({});
  console.log("codex-cli 0.171.0");
  process.exit(0);
}

if (args[0] === "login" && args[1] === "status") {
  log({});
  const login = process.env.FAKE_CC_LOGIN ?? "chatgpt";
  if (login === "chatgpt") {
    console.error("Logged in using ChatGPT");
    process.exit(0);
  }
  if (login === "apikey") {
    console.error("Logged in using an API key - sk-proj-***WXYZ");
    process.exit(0);
  }
  console.error("Not logged in");
  process.exit(1);
}

if (args[0] !== "cloud") {
  console.error(`fake codex: unexpected ${args.join(" ")}`);
  process.exit(2);
}

if (args[1] === "--help") {
  log({});
  console.log(`[EXPERIMENTAL] Browse tasks from Codex Cloud and apply changes locally

Usage: codex cloud [OPTIONS] [COMMAND]

Commands:
  exec    Submit a new Codex Cloud task without launching the TUI
  status  Show the status of a Codex Cloud task
  list    List Codex Cloud tasks
  apply   Apply the diff for a Codex Cloud task locally
  diff    Show the unified diff for a Codex Cloud task
  help    Print this message or the help of the given subcommand(s)`);
  process.exit(0);
}

if (args[1] === "exec" && args[2] === "--help") {
  log({});
  console.log(`Submit a new Codex Cloud task without launching the TUI

Usage: codex cloud exec [OPTIONS] --env <ENV_ID> [QUERY]

Options:
      --env <ENV_ID>     Target environment identifier (see \`codex cloud\` to browse)
      --branch <BRANCH>  Git branch to run in Codex Cloud (defaults to current branch)
${process.env.FAKE_CC_OLD ? "" : "      --attempts <ATTEMPTS>  Number of assistant attempts (best-of-N)"}`);
  process.exit(0);
}

const counter = (name) => {
  const file = join(dir, name);
  const n = existsSync(file) ? Number(readFileSync(file, "utf8")) + 1 : 1;
  writeFileSync(file, String(n));
  return n;
};

if (args[1] === "exec") {
  errorLog();
  const prompt = args.at(-1) === "-" ? readStdin() : args.at(-1);
  log({ prompt });
  const mode = process.env.FAKE_CC_EXEC ?? "ok";
  if (mode === "notfound") {
    console.error("Error: environment 'env_nope' not found; run `codex cloud` to list available environments");
    process.exit(1);
  }
  if (mode === "http500") {
    console.error("Error: request failed: 500 Internal Server Error (token sk-live-abcdefghijklmnopqrstuvwxyz)");
    process.exit(1);
  }
  // Long enough to outlast any send timeout under test, short enough that no test leaves it behind.
  if (mode === "hang") setTimeout(() => process.exit(1), 6_000);
  else if (mode === "evil") console.log("https://chatgpt.com.evil.example/codex/tasks/task_e_evil");
  else console.log(`https://chatgpt.com/codex/tasks/task_e_${counter("exec-count")}`);
} else if (args[1] === "status") {
  errorLog();
  log({});
  const states = (process.env.FAKE_CC_STATES ?? "READY").split(",");
  const state = states[Math.min(counter("status-count"), states.length) - 1];
  const title = process.env.FAKE_CC_TITLE ?? "Fix the login bug";
  console.log(`[${state}] ${title}`);
  console.log("env_fake  •  2m ago");
  console.log(state === "PENDING" ? "no diff" : "+12/-3 • 2 files");
  process.exit(state === "READY" ? 0 : 1);
} else if (args[1] === "diff") {
  errorLog();
  log({});
  console.log(`diff --git a/src/login.ts b/src/login.ts
index 1111111..2222222 100644
--- a/src/login.ts
+++ b/src/login.ts
@@ -1 +1 @@
-old
+new
diff --git a/src/login.test.ts b/src/login.test.ts
new file mode 100644
--- /dev/null
+++ b/src/login.test.ts
@@ -0,0 +1 @@
+test`);
} else {
  console.error(`fake codex: unexpected ${args.join(" ")}`);
  process.exit(2);
}
