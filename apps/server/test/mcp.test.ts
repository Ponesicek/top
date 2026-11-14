import assert from "node:assert/strict";
import { resolve } from "node:path";
import type { McpServerConfig, McpServerView } from "@top/protocol";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import { afterAll as after, test } from "vitest";
import { Events } from "../src/events.ts";
import * as Mcp from "../src/mcp.ts";
import { slug, toolName } from "../src/mcp.ts";
import { Store } from "../src/store.ts";
import type { TopTool } from "../src/tools.ts";
import { type Harness, harness } from "./harness.ts";

const echoServer = resolve(import.meta.dirname, "fixtures/echo-mcp.mjs");
const stdio = (env: { name: string; value?: string }[] = []): McpServerConfig => ({ transport: "stdio", command: process.execPath, args: [echoServer], env });

const cleanup: (() => Promise<void> | void)[] = [];
after(async () => {
  for (const fn of cleanup.reverse()) await fn();
});

async function setup() {
  const h = await harness({ bots: ["Atlas", "Scout"], mcp: true });
  const mcp = h.mcp!;
  const [bot, other] = h.bots as [number, number];
  return {
    h,
    store: h.store,
    mcp,
    bot,
    other,
    save: (id: number | undefined, name: string, config: McpServerConfig) => h.run(mcp.save(id, name, config)),
    assign: (id: number, bot: number, on: boolean) => h.run(mcp.assign(id, bot, on)),
    views: () => h.run(mcp.views),
  };
}

/** Resolves with the server's view once `ready(view)` holds. */
async function until(h: Harness, id: number, ready: (view: McpServerView) => boolean, timeoutMs = 10_000): Promise<McpServerView> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const view = (await h.run(h.mcp!.views)).find((v) => v.id === id);
    if (view && ready(view)) return view;
    if (Date.now() > end) throw new Error(`timed out; last view: ${JSON.stringify(view)}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

let current: Harness | undefined;
const run = (tool: TopTool | undefined, args: Record<string, unknown>) => current!.run(tool!.run(args, { key: "k", bot: 1 }));
type Result = Effect.Success<ReturnType<TopTool["run"]>>;
const textOf = (result: Result) => (result.content[0] as { text: string }).text;

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
  const { h, mcp, bot, other, save, assign, views } = await setup();
  current = h;
  const id = await save(undefined, "Echo", stdio());
  const view = await until(h, id, (v) => v.state === "ready");
  assert.deepEqual(view.tools, ["echo", "env", "fail"]);
  assert.deepEqual(mcp.toolsFor(bot), []);

  await assign(id, bot, true);
  assert.deepEqual((await views())[0]!.bots, [bot]);
  const tools = mcp.toolsFor(bot);
  assert.deepEqual(
    tools.map((t) => t.name),
    ["echo__echo", "echo__env", "echo__fail"],
  );
  assert.deepEqual(mcp.toolsFor(other), []);
  assert.match(tools[0]!.description, /MCP server "Echo"/);
  // Read-only tools run again after a restart; the rest are reported as interrupted.
  assert.deepEqual(
    tools.map((t) => t.replay),
    ["safe", "never", "never"],
  );

  assert.equal(textOf(await run(tools[0], { text: "hi" })), "echo: hi");
  const failed = await run(tools[2], {});
  assert.equal(failed.isError, true);

  await assign(id, bot, false);
  assert.deepEqual(mcp.toolsFor(bot), []);
});

test("secrets never leave the daemon, and an empty value keeps the stored one", async () => {
  const { h, mcp, bot, save, assign, views } = await setup();
  current = h;
  const id = await save(undefined, "Echo", stdio([{ name: "TOKEN", value: "s3cret" }]));
  await assign(id, bot, true);
  let view = await until(h, id, (v) => v.state === "ready");
  assert.deepEqual(view.config, { transport: "stdio", command: process.execPath, args: [echoServer], env: [{ name: "TOKEN" }] });
  assert.ok(!JSON.stringify(await views()).includes("s3cret"));

  const env = () =>
    run(
      mcp.toolsFor(bot).find((t) => t.name === "echo__env"),
      { name: "TOKEN" },
    ).then(textOf);
  assert.equal(await env(), "s3cret");

  // Saved again without a value (as the app does when it isn't changed): reconnects with the old one.
  await save(id, "Echo", stdio([{ name: "TOKEN" }]));
  view = await until(h, id, (v) => v.state === "ready");
  assert.equal(await env(), "s3cret");

  await assert.rejects(save(undefined, "Echo 2", stdio([{ name: "NEW" }])), /Give the variable NEW a value/);
  await assert.rejects(save(undefined, "Echo 2", stdio([{ name: "BAD-NAME", value: "x" }])), /isn't a valid environment variable/);
});

test("one server can be added twice, as two accounts, and each bot picks", async () => {
  const { h, mcp, bot, other, save, assign } = await setup();
  current = h;
  const work = await save(undefined, "Echo (work)", stdio([{ name: "ACCOUNT", value: "work" }]));
  const home = await save(undefined, "Echo (home)", stdio([{ name: "ACCOUNT", value: "home" }]));
  await until(h, work, (v) => v.state === "ready");
  await until(h, home, (v) => v.state === "ready");
  await assign(work, bot, true);
  await assign(home, bot, true);
  await assign(home, other, true);

  const names = mcp.toolsFor(bot).map((t) => t.name);
  assert.ok(names.includes("echo_work__env") && names.includes("echo_home__env"));
  assert.deepEqual(
    mcp.toolsFor(other).map((t) => t.name),
    ["echo_home__echo", "echo_home__env", "echo_home__fail"],
  );
  const account = (tool: string) =>
    run(
      mcp.toolsFor(bot).find((t) => t.name === tool),
      { name: "ACCOUNT" },
    ).then(textOf);
  assert.equal(await account("echo_work__env"), "work");
  assert.equal(await account("echo_home__env"), "home");

  await assert.rejects(save(undefined, "echo (WORK)", stdio()), /already a server named/);
  await assert.rejects(save(undefined, "Echo work!", stdio()), /too close to Echo \(work\)/);
});

test("a server that won't start says why, and removing one takes its tools away", async () => {
  const { h, mcp, bot, save, assign } = await setup();
  current = h;
  const broken = await save(undefined, "Broken", {
    transport: "stdio",
    command: process.execPath,
    args: ["-e", "console.error('missing API key'); process.exit(1)"],
    env: [],
  });
  const view = await until(h, broken, (v) => v.state === "failed");
  assert.match(view.error ?? "", /missing API key/);

  const id = await save(undefined, "Echo", stdio());
  await until(h, id, (v) => v.state === "ready");
  await assign(id, bot, true);
  const scope = await h.run(Scope.make());
  const { subscription } = await h.run(h.events.subscribe.pipe(Scope.provide(scope)));
  const tool = mcp.toolsFor(bot)[0];
  await h.run(mcp.delete(id));
  const removed = (await h.run(PubSub.takeAll(subscription))).flatMap((e) => (e._tag === "McpServerRemoved" ? [e.id] : []));
  assert.deepEqual(removed, [id]);
  assert.deepEqual(mcp.toolsFor(bot), []);
  // A call the model made just before: an error result, not a crash.
  await assert.rejects(run(tool, { text: "hi" }), /isn't connected/);
});

test("assignments survive a restart and go with a deleted bot", async () => {
  const { h, store, mcp, bot, other, save, assign, views } = await setup();
  const id = await save(undefined, "Echo", stdio());
  await assign(id, bot, true);
  await assign(id, other, true);
  await h.run(store.markDeleted(other));
  await h.run(mcp.botRemoved(other));
  assert.deepEqual((await views())[0]!.bots, [bot]);

  const again = ManagedRuntime.make(
    Mcp.layer({ oauthPort: 0 }).pipe(Layer.provide(Layer.mergeAll(Layer.succeed(Store, store), Layer.succeed(Events, h.events)))),
  );
  cleanup.push(() => again.dispose());
  assert.deepEqual((await again.runPromise(Effect.flatMap(Effect.service(Mcp.Mcp), (m) => m.views)))[0]!.bots, [bot]);
  await h.run(store.purgeBot(other));
  assert.deepEqual((await h.run(store.mcpAssignments)).get(id), [bot]);
});

test("an HTTP server is checked and its headers are hidden", async () => {
  const { save, views } = await setup();
  await assert.rejects(save(undefined, "Remote", { transport: "http", url: "not a url", headers: [] }), /full URL/);
  await assert.rejects(save(undefined, "Remote", { transport: "http", url: "ftp://x", headers: [] }), /https:\/\//);
  const id = await save(undefined, "Remote", { transport: "http", url: "http://127.0.0.1:1/mcp", headers: [{ name: "Authorization", value: "Bearer abc" }] });
  const view = (await views()).find((v) => v.id === id)!;
  assert.deepEqual(view.config, { transport: "http", url: "http://127.0.0.1:1/mcp", headers: [{ name: "Authorization" }] });
});
