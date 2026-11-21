import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { AccountInfo, CanUseTool, EffortLevel, Options, SDKMessage, SDKUserMessage, SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import { getCurrentSystemPrompt, renderSystemMessageUpdate, type SystemMessage, type ToolCall, type ToolResultMessage } from "@earendil-works/pi-ai";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { runToolCall, type ThinkingLevel } from "./loop.ts";
import type { TopAssistantMessage, TopUserMessage, TranscriptMessage } from "./messages.ts";
import type { BotRuntime, TurnOptions } from "./runtime.ts";
import { findCli, harnessEnv, redact, tail } from "./tasks/harness.ts";
import type { TopTool } from "./tools.ts";

/** The MCP server Top's tools reach Claude Code through, in the daemon's process: Claude sees them as `mcp__top__<name>`. */
export const TOOL_SERVER = "top";
const TOOL_PREFIX = `mcp__${TOOL_SERVER}__`;
const TOOL_USE_ID = "claudecode/toolUseId";
const INTERRUPT_MS = 15_000;
const STEER_POLL_MS = 250;

export type ClaudeQuery = AsyncIterable<SDKMessage> & {
  readonly interrupt: () => Promise<unknown>;
  readonly close: () => void;
  readonly accountInfo: () => Promise<AccountInfo>;
};

/** The parts of the Agent SDK Top calls, so tests can stand in for it. */
export type ClaudeSdk = {
  readonly query: (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => ClaudeQuery;
  /** The session's messages as Claude Code saved them, or none when it has no such session. */
  readonly sessionMessages: (session: string, cwd: string) => Promise<readonly SessionEntry[]>;
};

export type SessionEntry = { readonly type: string; readonly uuid: string; readonly message: unknown };

export const realSdk = async (): Promise<ClaudeSdk> => {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  return {
    query: (params) => sdk.query(params) as unknown as ClaudeQuery,
    sessionMessages: (session, cwd) => sdk.getSessionMessages(session, { dir: cwd }).catch(() => []),
  };
};

export type ClaudeRuntimeConfig = {
  /** What follows `claude/` in the bot's model: an alias such as `opus` or `sonnet`, a full model id, or `default` for Claude Code's own choice. */
  readonly model: Effect.Effect<string>;
  /** The bot's folder: Claude Code works there, and keeps the session under its own folder for it. */
  readonly cwd: string;
  /** The Claude Code CLI on the daemon's computer. */
  readonly cli: () => Promise<string>;
  readonly sdk: () => Promise<ClaudeSdk>;
  readonly session: Effect.Effect<string | null>;
  readonly saveSession: (session: string) => Effect.Effect<void>;
  readonly env?: (() => Record<string, string | undefined>) | undefined;
  /** Starts Claude Code so it dies with the daemon (Linux), instead of finishing its turn on its own with no Top to run the tools. */
  readonly spawn?: ((options: SpawnOptions) => SpawnedProcess) | undefined;
};

export const EFFORTS: Readonly<Record<ThinkingLevel, EffortLevel | undefined>> = {
  off: "low",
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

/** A Claude subscription signed in through Claude Code itself, or why this isn't one. Top never runs Claude bots on API credits. */
export function subscriptionProblem(info: AccountInfo): string | undefined {
  const signIn = "Run `claude` on the daemon's computer and sign in with your Claude account (`/login`), then send the message again.";
  if (info.apiProvider && info.apiProvider !== "firstParty")
    return `Claude Code on the daemon's computer goes through ${info.apiProvider}, not a Claude subscription, and Top's Claude bots only run on your Claude subscription. ${signIn}`;
  if (info.apiKeySource && info.apiKeySource !== "none" && info.apiKeySource !== "oauth")
    return `Claude Code on the daemon's computer uses an API key (${info.apiKeySource}), which bills API credits; Top's Claude bots only run on your Claude subscription. ${signIn}`;
  if (!info.subscriptionType) return `Claude Code on the daemon's computer isn't signed in with a Claude subscription. ${signIn}`;
  return undefined;
}

const SIGN_IN = "Run `claude` on the daemon's computer and sign in with your Claude account.";

/** Finds the Claude Code CLI once (`TOP_CLAUDE_PATH`, else `claude` on the PATH or in ~/.local/bin), the same one coding tasks use. */
export function claudeCli(command = process.env.TOP_CLAUDE_PATH ?? "claude") {
  let found: Promise<string> | undefined;
  const locate = () => {
    found ??= findCli(command, "Claude Code", "TOP_CLAUDE_PATH", `Install Claude Code and sign in by running \`claude\` once`);
    found.catch(() => {
      found = undefined;
    });
    return found;
  };
  const exec = (path: string, args: string[]) =>
    new Promise<{ ok: boolean; stdout: string; error?: string }>((resolve) =>
      execFile(path, args, { timeout: 15_000, env: harnessEnv(process.env) }, (error, stdout) =>
        resolve(error ? { ok: false, stdout, error: error.message } : { ok: true, stdout }),
      ),
    );
  /**
   * Installed and signed in, as `claude auth status` tells it. Whether that sign-in is a Claude subscription is checked
   * again each time a bot starts (`subscriptionProblem`): it's the only thing that can tell a subscription from an API key.
   */
  const status = async (): Promise<{ ok: true; version: string } | { ok: false; error: string }> => {
    let path: string;
    try {
      path = await locate();
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    const version = await exec(path, ["--version"]);
    if (!version.ok) return { ok: false, error: `\`${command} --version\` failed: ${redact(version.error ?? "")}` };
    const auth = await exec(path, ["auth", "status", "--json"]);
    let parsed: Record<string, unknown> = {};
    try {
      parsed = record(JSON.parse(auth.stdout));
    } catch {}
    if (parsed.loggedIn !== true) return { ok: false, error: `Claude Code isn't signed in on the daemon's computer. ${SIGN_IN}` };
    if (typeof parsed.apiProvider === "string" && parsed.apiProvider !== "firstParty")
      return { ok: false, error: `Claude Code on the daemon's computer goes through ${parsed.apiProvider}, not a Claude subscription. ${SIGN_IN}` };
    return { ok: true, version: version.stdout.trim() };
  };
  return { locate, status };
}

/** Starts the CLI through `setpriv --pdeathsig KILL`, so it can't outlive the daemon. Elsewhere, the SDK's own spawn. */
export function dyingSpawn(onStderr?: (data: string) => void): ((options: SpawnOptions) => SpawnedProcess) | undefined {
  if (process.platform !== "linux" || !existsSync("/usr/bin/setpriv")) return undefined;
  return (options) => {
    const child = spawn("/usr/bin/setpriv", ["--pdeathsig", "KILL", "--", options.command, ...options.args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (data: string) => onStderr?.(data));
    options.signal.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
    return child;
  };
}

/** The same id for the same Top message every time, so after a restart Top can tell whether Claude Code saved it. */
export const promptUuid = (session: string, message: TranscriptMessage): string => {
  const hash = createHash("sha256")
    .update(`${session}\0${message.timestamp}\0${JSON.stringify(message.content)}`)
    .digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
};

type Block =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "tool_result"; tool_use_id: string; content: unknown };

const userBlocks = (message: TopUserMessage): Block[] =>
  typeof message.content === "string"
    ? [{ type: "text", text: message.content }]
    : message.content.flatMap((part): Block[] =>
        part.type === "text"
          ? part.text
            ? [{ type: "text", text: part.text }]
            : []
          : part.data
            ? [{ type: "image", source: { type: "base64", media_type: part.mimeType, data: part.data } }]
            : [],
      );

const resultText = (content: readonly { readonly type: string; readonly text?: string }[] | string | undefined): string =>
  typeof content === "string" ? content : (content ?? []).map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("");

const record = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {});

/** What Claude Code's saved session says each tool call returned. */
function sessionResults(entries: readonly SessionEntry[]): Map<string, string> {
  const results = new Map<string, string>();
  for (const entry of entries) {
    const content = record(entry.message).content;
    if (entry.type !== "user" || !Array.isArray(content)) continue;
    for (const block of content.map(record))
      if (block.type === "tool_result" && typeof block.tool_use_id === "string")
        results.set(block.tool_use_id, resultText(block.content as Parameters<typeof resultText>[0]));
  }
  return results;
}

const sdkUser = (uuid: string, content: Block[], priority?: "next"): SDKUserMessage =>
  ({ type: "user", uuid, parent_tool_use_id: null, message: { role: "user", content }, ...(priority ? { priority } : {}) }) as SDKUserMessage;

class Inbox implements AsyncIterable<SDKUserMessage> {
  readonly #queue: SDKUserMessage[] = [];
  #wake: (() => void) | undefined;
  #done = false;

  push(message: SDKUserMessage) {
    this.#queue.push(message);
    this.#wake?.();
  }

  end() {
    this.#done = true;
    this.#wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    for (;;) {
      const next = this.#queue.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.#done) return;
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
      this.#wake = undefined;
    }
  }
}

const EMPTY_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function usageOf(raw: unknown): TopAssistantMessage["usage"] {
  const u = record(raw);
  const n = (key: string) => (typeof u[key] === "number" ? (u[key] as number) : 0);
  const input = n("input_tokens");
  const output = n("output_tokens");
  const cacheRead = n("cache_read_input_tokens");
  const cacheWrite = n("cache_creation_input_tokens");
  return { ...EMPTY_USAGE, input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite };
}

/** A tool's parameters as plain JSON Schema: TypeBox schemas carry symbols the MCP wire would drop anyway. */
const jsonSchema = (tool: TopTool): Record<string, unknown> => JSON.parse(JSON.stringify(tool.parameters)) as Record<string, unknown>;

const RESTARTED = "[Top: the daemon restarted during your turn. Carry on where you left off.]";

/**
 * What to send Claude Code when Top carries on a turn its session didn't finish (after a restart): Top's record of the
 * tool calls the session lacks or has another result for (Claude Code marks a call it lost as interrupted), and the
 * user's messages it never saved.
 */
export function catchUp(open: readonly TranscriptMessage[], known: readonly SessionEntry[], session: string) {
  const seen = new Set(known.map((entry) => entry.uuid));
  const results = sessionResults(known);
  const unsent = open.filter((m): m is TopUserMessage => m.role === "user" && !seen.has(promptUuid(session, m)));
  const settled = open.filter((m): m is ToolResultMessage => m.role === "toolResult" && results.get(m.toolCallId) !== resultText(m.content));
  const calls = new Map(
    open.flatMap((m) => (m.role === "assistant" ? m.content.filter((part): part is ToolCall => part.type === "toolCall") : [])).map((call) => [call.id, call]),
  );
  const note = settled.length
    ? [
        '[Top: the daemon restarted during your turn, and Claude Code lost part of it: it may show the turn as interrupted, or as answered with "No response requested.", which Claude Code wrote itself during the restart. You had called these tools; this is what Top recorded for each:]',
        ...settled.map(
          (m) =>
            `- ${m.toolName} ${JSON.stringify(calls.get(m.toolCallId)?.arguments ?? {})} (${m.toolCallId})${m.isError ? ", error" : ""}: ${resultText(m.content)}`,
        ),
      ].join("\n")
    : unsent.length
      ? undefined
      : RESTARTED;
  return { note, unsent };
}

/** The messages since the last answer that called no tools: the turn a restart may have cut short. */
function openTurn(messages: readonly TranscriptMessage[]): TranscriptMessage[] {
  const last = messages.findLastIndex((m) => m.role === "assistant" && !m.content.some((part) => part.type === "toolCall"));
  return messages.slice(last + 1);
}

type Outcome = { readonly error?: string; readonly aborted?: boolean };

type Conversation = {
  readonly config: ClaudeRuntimeConfig;
  readonly options: TurnOptions;
  readonly path: string;
  readonly sdk: ClaudeSdk;
  readonly session: string;
  readonly model: string;
  readonly fresh: boolean;
  readonly opening: readonly SDKUserMessage[];
  /** Runs one of Top's effects (a save, a tool) as a fiber of the turn; refused once the daemon stopped the turn. */
  readonly run: <A>(effect: Effect.Effect<A>) => Promise<A>;
};

/** One launch of Claude Code: the opening messages, then whatever it does, until every message given it was answered. */
async function converse({ config, options, path, sdk, session, model, fresh, opening, run }: Conversation): Promise<Outcome> {
  const { messages, hooks, signal } = options;
  const inbox = new Inbox();
  const outstanding = new Set<string>();
  const toolOptions = { tools: options.tools, hooks, signal, stopped: options.stopped, toolContext: options.toolContext };
  const toolNamed = new Map(options.tools.map((tool) => [tool.name, tool]));

  // Claude Code sends each block of an answer as its own message; Top saves one entry per answer, once it's whole or
  // once one of its tools is called, whichever comes first.
  let pending: { id: string; model: string; content: TopAssistantMessage["content"]; usage: unknown } | undefined;
  const saved = new Map<string, () => void>();
  const savedIds = new Set<string>();
  const flush = async () => {
    const answer = pending;
    pending = undefined;
    if (!answer?.content.length) return;
    const calls = answer.content.filter((part): part is ToolCall => part.type === "toolCall");
    const message: TopAssistantMessage = {
      role: "assistant",
      content: answer.content,
      api: "claude-agent-sdk",
      provider: "claude",
      model: answer.model,
      usage: usageOf(answer.usage),
      stopReason: calls.length ? "toolUse" : "stop",
      timestamp: Date.now(),
    };
    messages.push(message);
    await run(hooks.added(message));
    for (const call of calls) {
      savedIds.add(call.id);
      saved.get(call.id)?.();
      saved.delete(call.id);
    }
  };
  // A call is recorded against the saved answer it came in, so the answer is saved before the call runs.
  const whenSaved = (toolUseId: string) =>
    savedIds.has(toolUseId)
      ? Promise.resolve()
      : pending?.content.some((part) => part.type === "toolCall" && part.id === toolUseId)
        ? flush()
        : new Promise<void>((resolve) => {
            saved.set(toolUseId, resolve);
            setTimeout(resolve, 5_000);
          });

  let sequential = Promise.resolve();
  const running = new Set<Promise<unknown>>();
  const callTool = async (name: string, args: unknown, toolUseId: string) => {
    await whenSaved(toolUseId);
    const call: ToolCall = { type: "toolCall", id: toolUseId, name, arguments: record(args) as ToolCall["arguments"] };
    const go = async () => {
      const ran = run(runToolCall(toolOptions, call));
      running.add(ran);
      const { done } = await ran.finally(() => running.delete(ran));
      messages.push(done);
      return done;
    };
    let done: ToolResultMessage;
    if (toolNamed.get(name)?.executionMode === "sequential") {
      const next = sequential.then(go);
      sequential = next.then(
        () => undefined,
        () => undefined,
      );
      done = await next;
    } else done = await go();
    return {
      content: done.content.map((part) =>
        part.type === "text" ? { type: "text" as const, text: part.text } : { type: "image" as const, data: part.data, mimeType: part.mimeType },
      ),
      ...(done.isError ? { isError: true } : {}),
    };
  };

  const { createSdkMcpServer } = await import("@anthropic-ai/claude-agent-sdk");
  const server = createSdkMcpServer({ name: TOOL_SERVER, version: "1.0.0", tools: [], alwaysLoad: true });
  // Top's tools are JSON Schema (TypeBox), so the server answers MCP's tool requests itself rather than through `tool()`'s zod.
  const low = (server.instance as unknown as { server: { registerCapabilities: (c: unknown) => void; setRequestHandler: (s: unknown, h: unknown) => void } })
    .server;
  low.registerCapabilities({ tools: {} });
  low.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: options.tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: jsonSchema(tool) })),
  }));
  low.setRequestHandler(CallToolRequestSchema, async (request: { params: { name: string; arguments?: unknown; _meta?: Record<string, unknown> } }) => {
    const meta = request.params._meta?.[TOOL_USE_ID];
    return callTool(request.params.name, request.params.arguments ?? {}, typeof meta === "string" ? meta : `top-${randomUUID()}`);
  });

  // Only Top's own tools run: Claude Code's built-in tools are switched off, and anything else it asks for is refused.
  const canUseTool: CanUseTool = async (name, input) =>
    name.startsWith(TOOL_PREFIX) ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: `${name} isn't one of this bot's tools.` };

  const abort = new AbortController();
  let stderr = "";
  const keepStderr = (data: string) => {
    stderr = tail(stderr + data, 4_000);
  };
  const spawner = config.spawn ?? dyingSpawn(keepStderr);
  const q = sdk.query({
    prompt: inbox,
    options: {
      cwd: config.cwd,
      pathToClaudeCodeExecutable: path,
      env: (config.env ?? (() => harnessEnv(process.env)))(),
      abortController: abort,
      ...(model && model !== "default" ? { model } : {}),
      ...(EFFORTS[options.thinkingLevel] ? { effort: EFFORTS[options.thinkingLevel]! } : {}),
      systemPrompt: getCurrentSystemPrompt(messages),
      tools: [],
      settingSources: [],
      settings: { autoMemoryEnabled: false },
      strictMcpConfig: true,
      mcpServers: { [TOOL_SERVER]: server },
      permissionMode: "default",
      canUseTool,
      ...(fresh ? { sessionId: session } : { resume: session }),
      ...(spawner ? { spawnClaudeCodeProcess: spawner } : {}),
      stderr: keepStderr,
    },
  });
  const close = () => {
    inbox.end();
    try {
      q.close();
    } catch {}
    abort.abort();
  };
  const stderrTail = () => (stderr.trim() ? `\n${tail(redact(stderr.trim()), 600)}` : "");

  // Steering goes in as soon as Top has it, between the steps of the turn Claude Code is taking.
  const takeSteering = () => {
    const steering = signal.aborted ? [] : options.steering();
    const queued: { message: TranscriptMessage; uuid: string }[] = [];
    for (const message of steering) {
      const uuid = promptUuid(session, message);
      if (message.role === "user") outstanding.add(uuid);
      queued.push({ message, uuid });
    }
    return Promise.all(
      queued.map(async ({ message, uuid }) => {
        messages.push(message);
        await run(hooks.added(message));
        if (message.role !== "user") return;
        const [withImages] = options.transformContext ? await run(options.transformContext([message])) : [message];
        inbox.push(sdkUser(uuid, userBlocks(withImages as TopUserMessage), "next"));
      }),
    );
  };

  let steer: NodeJS.Timeout | undefined;
  const onAbort = () => {
    void Promise.race([q.interrupt().catch(() => {}), new Promise((resolve) => setTimeout(resolve, INTERRUPT_MS))]).then(close);
  };
  try {
    const account = await q.accountInfo().catch((error: unknown) => {
      throw new Error(`Claude Code didn't start: ${redact(error instanceof Error ? error.message : String(error))}${stderrTail()}`);
    });
    const problem = subscriptionProblem(account);
    if (problem) return { error: problem };
    if (signal.aborted) return { aborted: true };
    signal.addEventListener("abort", onAbort, { once: true });

    for (const message of opening) {
      outstanding.add(message.uuid!);
      inbox.push(message);
    }
    steer = setInterval(() => void takeSteering().catch(() => {}), STEER_POLL_MS);

    for await (const message of q) {
      if (message.type === "assistant") {
        if (message.parent_tool_use_id) continue;
        const body = message.message;
        if (pending && pending.id !== body.id) await flush();
        pending ??= { id: body.id, model: body.model, content: [], usage: body.usage };
        pending.usage = body.usage;
        for (const block of body.content as unknown as Record<string, unknown>[]) {
          if (block.type === "text" && typeof block.text === "string") pending.content.push({ type: "text", text: block.text });
          else if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking)
            pending.content.push({ type: "thinking", thinking: block.thinking });
          else if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string")
            pending.content.push({
              type: "toolCall",
              id: block.id,
              name: block.name.startsWith(TOOL_PREFIX) ? block.name.slice(TOOL_PREFIX.length) : block.name,
              arguments: record(block.input) as ToolCall["arguments"],
            });
        }
        continue;
      }
      if (message.type === "system" && message.subtype === "compact_boundary") {
        await flush();
        if (hooks.notice) await run(hooks.notice("Claude Code compacted the conversation to make room. The messages stay here."));
        continue;
      }
      if (message.type !== "result") continue;
      await flush();
      const answered = message.user_message_uuids ?? (message.user_message_uuid ? [message.user_message_uuid] : undefined);
      if (answered?.length) for (const uuid of answered) outstanding.delete(uuid);
      else outstanding.clear();
      if (signal.aborted) return { aborted: true };
      if (message.subtype !== "success" || message.is_error) {
        const text = message.subtype === "success" ? message.result : [message.subtype, ...(message.errors ?? [])].join(": ");
        return { error: redact(text || "Claude Code's turn failed") };
      }
      await takeSteering();
      if (outstanding.size === 0) return {};
    }
    if (signal.aborted) return { aborted: true };
    return { error: `Claude Code stopped.${stderrTail()}` };
  } catch (error) {
    if (signal.aborted) return { aborted: true };
    return { error: `Claude Code stopped: ${redact(error instanceof Error ? error.message : String(error))}${stderrTail()}` };
  } finally {
    if (steer) clearInterval(steer);
    signal.removeEventListener("abort", onAbort);
    close();
    // A call cut off by Stop ends once its tool sees the signal; its result is saved before the turn ends, as on Top's loop.
    await Promise.allSettled([...running]);
    await flush().catch(() => {});
  }
}

export function claudeRuntime(config: ClaudeRuntimeConfig): BotRuntime {
  const turn = (options: TurnOptions, prompts?: readonly TranscriptMessage[]) =>
    Effect.gen(function* () {
      const { messages, hooks } = options;
      const services = yield* Effect.context<never>();
      const model = yield* config.model;

      for (const message of prompts ?? []) {
        messages.push(message);
        yield* hooks.added(message);
      }
      yield* hooks.asking;

      const fail = (errorMessage: string, aborted = false) =>
        Effect.gen(function* () {
          const failed: TopAssistantMessage = {
            role: "assistant",
            content: [{ type: "text", text: "" }],
            api: "claude-agent-sdk",
            provider: "claude",
            model,
            usage: EMPTY_USAGE,
            stopReason: aborted ? "aborted" : "error",
            errorMessage,
            timestamp: yield* Clock.currentTimeMillis,
          };
          messages.push(failed);
          yield* hooks.added(failed);
        });

      const ready = yield* Effect.promise(async () => {
        try {
          return { path: await config.cli(), sdk: await config.sdk() };
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error) };
        }
      });
      if ("error" in ready) return yield* fail(ready.error);
      const { path, sdk } = ready;

      const saved = yield* config.session;
      const known = saved ? yield* Effect.promise(() => sdk.sessionMessages(saved, config.cwd)) : [];
      const fresh = known.length === 0;
      const session = saved ?? randomUUID();
      if (!saved) yield* config.saveSession(session);

      const needed = prompts?.length ? prompts : openTurn(messages);
      const transformed = options.transformContext ? yield* options.transformContext(needed) : needed;
      const view = new Map(needed.map((m, i) => [m, transformed[i] ?? m]));
      const withData = (m: TopUserMessage) => (view.get(m) ?? m) as TopUserMessage;

      // This launch's first messages: the new prompts, each with its own id, or what a restart left unsaid.
      const opening: SDKUserMessage[] = [];
      const userMessage = (m: TopUserMessage, extra: Block[] = []) => sdkUser(promptUuid(session, m), [...extra, ...userBlocks(withData(m))]);
      if (fresh && messages.some((m) => m.role === "assistant"))
        opening.push(
          sdkUser(randomUUID(), [
            {
              type: "text",
              text: "[Top: Claude Code has no record of this conversation (its session is gone), so you start without its earlier messages. The user still sees them in the app.]",
            },
          ]),
        );
      if (prompts?.length) {
        // A new session's system prompt has the files as they are now; a running one hears of each change at its next message.
        const updates = fresh
          ? []
          : prompts
              .filter((m): m is SystemMessage => m.role === "system")
              .map(renderSystemMessageUpdate)
              .filter(Boolean);
        let extra: Block[] = updates.map((text) => ({ type: "text", text: `<top-system-update>\n${text}\n</top-system-update>` }));
        for (const m of prompts) {
          if (m.role !== "user") continue;
          opening.push(userMessage(m, extra));
          extra = [];
        }
        if (extra.length) opening.push(sdkUser(randomUUID(), extra));
      } else {
        const { note, unsent } = catchUp(openTurn(messages), known, session);
        if (note && !fresh) opening.push(sdkUser(randomUUID(), [{ type: "text", text: note }]));
        for (const m of unsent) opening.push(userMessage(m));
      }
      if (!opening.length) opening.push(sdkUser(randomUUID(), [{ type: "text", text: RESTARTED }]));

      // Top's side of the turn (saving entries, running tools) runs as fibers of its own while Claude Code calls in; when
      // the daemon stops the turn, they're interrupted with it, and nothing more is saved.
      let closing = false;
      const fibers = new Set<Fiber.Fiber<unknown>>();
      const run = <A>(effect: Effect.Effect<A>): Promise<A> => {
        if (closing) return Promise.reject(new Error("Stopped"));
        const fiber = Effect.runForkWith(services)(effect);
        fibers.add(fiber);
        return Effect.runPromiseWith(services)(Fiber.join(fiber)).finally(() => fibers.delete(fiber));
      };
      const outcome = yield* Effect.promise((interrupted) => {
        interrupted.addEventListener(
          "abort",
          () => {
            closing = true;
            Effect.runForkWith(services)(Fiber.interruptAll(fibers));
          },
          { once: true },
        );
        return converse({ config, options, path, sdk, session, model, fresh, opening, run });
      });
      if (outcome.error) yield* fail(outcome.error);
      else if (outcome.aborted) yield* fail("Stopped", true);
    }).pipe(Effect.withSpan("Claude.turn"));

  return { id: "claude", retries: false, turn };
}
