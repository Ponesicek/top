import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import type { McpServerConfig, McpServerView } from "@top/protocol";
import { McpManager, slug, toolName } from "../src/mcp.ts";
import { Store } from "../src/store.ts";
import type { TopTool } from "../src/tools.ts";

const echoServer = resolve(import.meta.dirname, "fixtures/echo-mcp.mjs");
const stdio = (env: { name: string; value?: string }[] = []): McpServerConfig => ({ transport: "stdio", command: process.execPath, args: [echoServer], env });

const cleanup: (() => Promise<void> | void)[] = [];
after(async () => {
  for (const fn of cleanup.reverse()) await fn();
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "top-mcp-"));
  const store = new Store(join(dir, "top.sqlite"));
  const mcp = new McpManager(store, { oauthPort: 0 });
  cleanup.push(async () => {
    await mcp.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const bot = store.createBot("Atlas", "", "fake/model");
  const other = store.createBot("Scout", "", "fake/model");
  return { store, mcp, bot, other };
}

/** Resolves with the server's view once `ready(view)` holds. */
function until(mcp: McpManager, id: number, ready: (view: McpServerView) => boolean, timeoutMs = 10_000): Promise<McpServerView> {
  return new Promise((resolveView, reject) => {
    const check = () => {
      const view = mcp.views().find((v) => v.id === id);
      if (view && ready(view)) {
        stop();
        clearTimeout(timer);
        resolveView(view);
      }
    };
    const stop = mcp.onChange(check);
    const timer = setTimeout(() => {
      stop();
      reject(new Error(`timed out; last view: ${JSON.stringify(mcp.views().find((v) => v.id === id))}`));
    }, timeoutMs);
    check();
  });
}

const run = (tool: TopTool | undefined, args: Record<string, unknown>) => tool!.run(args, { key: "k", bot: 1 });
const textOf = (result: Awaited<ReturnType<TopTool["run"]>>) => (result.content[0] as { text: string }).text;

test("tool names are prefixed with the server and fit what providers accept", () => {
  assert.equal(slug("GitHub (work)"), "github_work");
  assert.equal(toolName("GitHub (work)", "create_issue"), "github_work__create_issue");
  assert.equal(toolName("x", "a.b/c"), "x__a_b_c");
  const long = toolName("A very long server name indeed", "an_extremely_long_tool_name_that_goes_on_and_on_forever");
  assert.equal(long.length, 64);
  assert.match(long, /^[A-Za-z0-9_-]+$/);
  assert.notEqual(long, toolName("A very long server name indeed", "an_extremely_long_tool_name_that_goes_on_and_on_forever_2"));
});

test("a bot gets a server's tools only once it's assigned, and they run", async () => {
  const { mcp, bot, other } = setup();
  const id = mcp.save(undefined, "Echo", stdio());
  mcp.start();
  const view = await until(mcp, id, (v) => v.state === "ready");
  assert.deepEqual(view.tools, ["echo", "env", "fail"]);
  assert.deepEqual(mcp.toolsFor(bot), []);

  mcp.assign(id, bot, true);
  assert.deepEqual(mcp.views()[0]!.bots, [bot]);
  const tools = mcp.toolsFor(bot);
  assert.deepEqual(tools.map((t) => t.name), ["echo__echo", "echo__env", "echo__fail"]);
  assert.deepEqual(mcp.toolsFor(other), []);
  assert.match(tools[0]!.description, /MCP server "Echo"/);
  // Read-only tools run again after a restart; the rest are reported as interrupted.
  assert.deepEqual(tools.map((t) => t.replay), ["safe", "never", "never"]);

  assert.equal(textOf(await run(tools[0], { text: "hi" })), "echo: hi");
  const failed = await run(tools[2], {});
  assert.equal(failed.isError, true);

  mcp.assign(id, bot, false);
  assert.deepEqual(mcp.toolsFor(bot), []);
});

test("secrets never leave the daemon, and an empty value keeps the stored one", async () => {
  const { mcp, bot } = setup();
  const id = mcp.save(undefined, "Echo", stdio([{ name: "TOKEN", value: "s3cret" }]));
  mcp.start();
  mcp.assign(id, bot, true);
  let view = await until(mcp, id, (v) => v.state === "ready");
  assert.deepEqual(view.config, { transport: "stdio", command: process.execPath, args: [echoServer], env: [{ name: "TOKEN" }] });
  assert.ok(!JSON.stringify(mcp.views()).includes("s3cret"));

  const env = () => run(mcp.toolsFor(bot).find((t) => t.name === "echo__env"), { name: "TOKEN" }).then(textOf);
  assert.equal(await env(), "s3cret");

  // Saved again without a value (as the app does when it isn't changed): reconnects with the old one.
  mcp.save(id, "Echo", stdio([{ name: "TOKEN" }]));
  view = await until(mcp, id, (v) => v.state === "ready");
  assert.equal(await env(), "s3cret");

  assert.throws(() => mcp.save(undefined, "Echo 2", stdio([{ name: "NEW" }])), /Give the variable NEW a value/);
  assert.throws(() => mcp.save(undefined, "Echo 2", stdio([{ name: "BAD-NAME", value: "x" }])), /isn't a valid environment variable/);
});

test("one server can be added twice, as two accounts, and each bot picks", async () => {
  const { mcp, bot, other } = setup();
  const work = mcp.save(undefined, "Echo (work)", stdio([{ name: "ACCOUNT", value: "work" }]));
  const home = mcp.save(undefined, "Echo (home)", stdio([{ name: "ACCOUNT", value: "home" }]));
  mcp.start();
  await until(mcp, work, (v) => v.state === "ready");
  await until(mcp, home, (v) => v.state === "ready");
  mcp.assign(work, bot, true);
  mcp.assign(home, bot, true);
  mcp.assign(home, other, true);

  const names = mcp.toolsFor(bot).map((t) => t.name);
  assert.ok(names.includes("echo_work__env") && names.includes("echo_home__env"));
  assert.deepEqual(mcp.toolsFor(other).map((t) => t.name), ["echo_home__echo", "echo_home__env", "echo_home__fail"]);
  const account = (tool: string) => run(mcp.toolsFor(bot).find((t) => t.name === tool), { name: "ACCOUNT" }).then(textOf);
  assert.equal(await account("echo_work__env"), "work");
  assert.equal(await account("echo_home__env"), "home");

  assert.throws(() => mcp.save(undefined, "echo (WORK)", stdio()), /already a server named/);
  assert.throws(() => mcp.save(undefined, "Echo work!", stdio()), /too close to Echo \(work\)/);
});

test("a server that won't start says why, and removing one takes its tools away", async () => {
  const { mcp, bot } = setup();
  const broken = mcp.save(undefined, "Broken", { transport: "stdio", command: process.execPath, args: ["-e", "console.error('missing API key'); process.exit(1)"], env: [] });
  mcp.start();
  const view = await until(mcp, broken, (v) => v.state === "failed");
  assert.match(view.error ?? "", /missing API key/);

  const id = mcp.save(undefined, "Echo", stdio());
  await until(mcp, id, (v) => v.state === "ready");
  mcp.assign(id, bot, true);
  const removed: number[] = [];
  mcp.onRemoved((r) => removed.push(r));
  const tool = mcp.toolsFor(bot)[0];
  mcp.delete(id);
  assert.deepEqual(removed, [id]);
  assert.deepEqual(mcp.toolsFor(bot), []);
  // A call the model made just before: an error result, not a crash.
  await assert.rejects(run(tool, { text: "hi" }), /isn't connected/);
});

test("assignments survive a restart and go with a deleted bot", async () => {
  const { store, mcp, bot, other } = setup();
  const id = mcp.save(undefined, "Echo", stdio());
  mcp.assign(id, bot, true);
  mcp.assign(id, other, true);
  store.markDeleted(other);
  mcp.botRemoved(other);
  assert.deepEqual(mcp.views()[0]!.bots, [bot]);

  const again = new McpManager(store, { oauthPort: 0 });
  cleanup.push(() => again.close());
  assert.deepEqual(again.views()[0]!.bots, [bot]);
  store.purgeBot(other);
  assert.deepEqual(store.mcpAssignments().get(id), [bot]);
});

test("an HTTP server is checked and its headers are hidden", () => {
  const { mcp } = setup();
  assert.throws(() => mcp.save(undefined, "Remote", { transport: "http", url: "not a url", headers: [] }), /full URL/);
  assert.throws(() => mcp.save(undefined, "Remote", { transport: "http", url: "ftp://x", headers: [] }), /https:\/\//);
  const id = mcp.save(undefined, "Remote", { transport: "http", url: "http://127.0.0.1:1/mcp", headers: [{ name: "Authorization", value: "Bearer abc" }] });
  const view = mcp.views().find((v) => v.id === id)!;
  assert.deepEqual(view.config, { transport: "http", url: "http://127.0.0.1:1/mcp", headers: [{ name: "Authorization" }] });
});
