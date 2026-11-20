#!/usr/bin/env node
// A stand-in for `git clone` that never touches the network: it makes the destination folder with a CLONED marker.
// FAKE_GIT_DIR: a folder for its log (calls.jsonl). FAKE_GIT_FAIL: fail the clone as git does for a missing branch.
// FAKE_GIT_TAG: `--branch` named a tag, so the clone's HEAD is detached. `-C <dir> symbolic-ref --short HEAD` reads its HEAD.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
if (process.env.FAKE_GIT_DIR)
  appendFileSync(
    join(process.env.FAKE_GIT_DIR, "calls.jsonl"),
    `${JSON.stringify({ args, prompt: process.env.GIT_TERMINAL_PROMPT ?? null, bundle: process.env.CCR_FORCE_BUNDLE ?? null, repoVars: ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR", "GIT_NAMESPACE", "GIT_CEILING_DIRECTORIES", "GIT_DISCOVERY_ACROSS_FILESYSTEM"].filter((name) => name in process.env) })}\n`,
  );
if (args[0] === "-C" && args[2] === "symbolic-ref") {
  const head = join(args[1], ".fakehead");
  if (!existsSync(head)) {
    console.error("fatal: ref HEAD is not a symbolic ref");
    process.exit(128);
  }
  console.log(readFileSync(head, "utf8"));
  process.exit(0);
}
if (args[0] !== "clone") process.exit(2);
if (process.env.FAKE_GIT_FAIL) {
  console.error("fatal: Remote branch nope not found in upstream origin");
  process.exit(128);
}
const dest = args.at(-1);
mkdirSync(dest, { recursive: true });
writeFileSync(join(dest, "CLONED"), "");
if (!process.env.FAKE_GIT_TAG) writeFileSync(join(dest, ".fakehead"), args[3]);
