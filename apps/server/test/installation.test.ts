import assert from "node:assert/strict";
import { test } from "vitest";
import { DEFAULT_MODEL, daemonFlags } from "../src/installation.ts";

test("top install starts a fresh install on the default model and keeps an installed one's model unless --model is given", () => {
  assert.equal(DEFAULT_MODEL, "openai/gpt-6.2-sol");
  assert.deepEqual(daemonFlags(undefined, undefined), ["--model", DEFAULT_MODEL], "a fresh install");
  assert.deepEqual(daemonFlags(["--tailscale"], undefined), ["--model", DEFAULT_MODEL, "--tailscale"]);
  const saved = "--model\nopenai/gpt-6.1-sol\n";
  assert.equal(daemonFlags(undefined, saved), undefined, "a reinstall leaves the flags as they are");
  assert.deepEqual(daemonFlags(["--tailscale", "--tailscale-allow", "me@"], saved), [
    "--model",
    "openai/gpt-6.1-sol",
    "--tailscale",
    "--tailscale-allow",
    "me@",
  ]);
  assert.deepEqual(daemonFlags(["--tailscale"], "--tailscale\n"), ["--model", DEFAULT_MODEL, "--tailscale"], "a saved file without a model");
  assert.deepEqual(daemonFlags(["--model", "anthropic/claude-opus-5-5"], saved), ["--model", "anthropic/claude-opus-5-5"]);
});
