import assert from "node:assert/strict";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { test } from "vitest";
import { lastLine } from "../src/daemon.ts";
import { textOf } from "../src/wire.ts";
import { harness } from "./harness.ts";

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

test("while the bot is calling tools, the sidebar keeps its last answer that said something", async () => {
  const h = await harness();
  const answer = (content: AssistantMessage["content"]) => h.run(h.store.append(h.bot, "assistant", { ...fauxAssistantMessage(""), content, timestamp: 0 }));
  const said = async () => lastLine(textOf((await h.run(h.store.lastAnswer(h.bot)))?.content));

  await answer([{ type: "text", text: "Deployed the web service." }]);
  await answer([fauxToolCall("bash", { command: "ls" })]);
  await answer([{ type: "text", text: "" }]);
  assert.equal(await said(), "Deployed the web service.");

  await answer("Plain string content works too." as unknown as AssistantMessage["content"]);
  assert.equal(await said(), "Plain string content works too.");
});
