import assert from "node:assert/strict";
import { test } from "node:test";
import { lastLine } from "../src/daemon.ts";

test("the sidebar preview keeps hyphens and drops only Markdown syntax", () => {
  assert.equal(lastLine("Done.\n\n- **Follow-up** with `kill -9`"), "Follow-up with kill -9");
  assert.equal(lastLine("## Heading only"), "Heading only");
  assert.equal(lastLine("1. step one"), "step one");
  assert.equal(lastLine("> quoted -- text"), "quoted -- text");
});

test("the sidebar preview skips code fences and table rows", () => {
  assert.equal(lastLine("Here:\n```bash\nkill -9 1\n}\n```"), "Here:");
  assert.equal(lastLine("Intro\n| a | b |\n|---|---|\n| 1 | 2 |"), "Intro");
  assert.equal(lastLine("```\nonly code\n```"), "");
});
