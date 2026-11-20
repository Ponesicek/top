#!/usr/bin/env node
// A stand-in for `claude` (2.1.329) as far as `--cloud` and `auth status` go, printing what the docs say the real CLI prints
// (code.claude.com/docs/en/claude-code-on-the-web.md). It never touches the network.
// FAKE_CL_DIR: a folder for its log (calls.jsonl). FAKE_CL_AUTH: claude.ai (default) | api_key | none.
// FAKE_CL_START: ok (default) | branch | evil | refused | hang | late. FAKE_CL_SEND: ok (default) | archived | secret | silent.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.FAKE_CL_DIR;
const args = process.argv.slice(2);
const readStdin = () => (process.stdin.isTTY ? "" : readFileSync(0, "utf8"));
const log = (entry) =>
  dir &&
  appendFileSync(
    join(dir, "calls.jsonl"),
    `${JSON.stringify({ args, cwd: process.cwd(), bundle: process.env.CCR_FORCE_BUNDLE ?? null, cloned: existsSync(join(process.cwd(), "CLONED")), ...entry })}\n`,
  );

if (args[0] === "--version") {
  log({});
  console.log("2.1.329 (Claude Code)");
  process.exit(0);
}
if (args[0] === "--help") {
  log({});
  console.log(`Usage: claude [options] [command] [prompt]

Options:
  --cloud [description|session_id|url]  Create a cloud session with the given
                                        description, or attach to an existing
                                        one by session ID or claude.ai/code URL
  -p, --print                           Print response and exit (useful for
                                        pipes).`);
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "status") {
  log({});
  const method = process.env.FAKE_CL_AUTH ?? "claude.ai";
  console.log(JSON.stringify({ loggedIn: method !== "none", authMethod: method, email: "someone@example.com", orgId: "org_secret" }));
  process.exit(method === "none" ? 1 : 0);
}

const at = args.indexOf("--cloud");
if (at === -1) {
  console.error(`fake claude: unexpected ${args.join(" ")}`);
  process.exit(2);
}

if (args.includes("-p")) {
  const session = args[at + 1];
  const message = readStdin();
  log({ message });
  const mode = process.env.FAKE_CL_SEND ?? "ok";
  if (mode === "ok") console.log(JSON.stringify({ ok: true, session_id: session, url: `https://claude.ai/code/${session}?from=cli&m=1` }));
  else if (mode === "archived") {
    console.log(JSON.stringify({ ok: false, session_id: session, error: `cloud session ${session} is archived and cannot accept new messages` }));
    process.exit(1);
  } else if (mode === "secret") {
    console.log(JSON.stringify({ ok: false, session_id: session, error: "failed to send: Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123" }));
    process.exit(1);
  } else process.exit(1);
  process.exit(0);
}

log({ description: args[at + 1] });
const mode = process.env.FAKE_CL_START ?? "ok";
const id = "session_01FAKEFAKEFAKE";
if (mode === "refused") {
  console.error("Error: Cloud sessions are disabled by your organization's policy. Contact your organization admin to enable them.");
  process.exit(1);
}
// Long enough to outlast any start timeout under test, short enough that no test leaves it behind.
if (mode === "hang") setTimeout(() => process.exit(1), 6_000);
else if (mode === "evil") console.log("View: https://claude.ai.evil.example/code/session_01EVIL");
else {
  if (mode === "branch") console.log("Branch feature/x is not on GitHub; the session starts from main instead.");
  console.log(`Created cloud session.\nSession ID: ${id}\nView: https://claude.ai/code/${id}?from=cli&m=0`);
  // Still at work after printing the id (an upload, say): Top lets it finish.
  if (mode === "late") setTimeout(() => process.exit(0), 300);
}
