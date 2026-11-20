#!/usr/bin/env node
// A stand-in for `git clone` that never touches the network: it makes the destination folder with a CLONED marker.
// FAKE_GIT_DIR: a folder for its log (calls.jsonl). FAKE_GIT_FAIL: fail the clone as git does for a missing branch.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
if (process.env.FAKE_GIT_DIR)
  appendFileSync(
    join(process.env.FAKE_GIT_DIR, "calls.jsonl"),
    `${JSON.stringify({ args, prompt: process.env.GIT_TERMINAL_PROMPT ?? null, bundle: process.env.CCR_FORCE_BUNDLE ?? null })}\n`,
  );
if (args[0] !== "clone") process.exit(2);
if (process.env.FAKE_GIT_FAIL) {
  console.error("fatal: Remote branch nope not found in upstream origin");
  process.exit(128);
}
const dest = args.at(-1);
mkdirSync(dest, { recursive: true });
writeFileSync(join(dest, "CLONED"), "");
