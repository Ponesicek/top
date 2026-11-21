import { randomUUID } from "node:crypto";
import type { AccountInfo, Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ClaudeQuery, ClaudeSdk, SessionEntry } from "./claudeRuntime.ts";

/**
 * A stand-in for the Claude Agent SDK, for tests and fake bots: it keeps sessions in memory, calls Top's tools over the
 * real MCP server Top hands it, and answers by rule:
 *
 * - `call <tool> <json>` calls that tool (by Top's name), then says what it returned. Several calls go out as parts of
 *   one answer, each running as soon as it's out; with `nometa` they come without Claude Code's tool-use id.
 * - `hang` never answers (until it's interrupted or closed).
 * - anything else gets "Claude heard: <the message's last line>".
 */
export type FakeClaude = ClaudeSdk & {
  readonly sessions: Map<string, SessionEntry[]>;
  /** Every launch's options, newest last. */
  readonly launches: Options[];
  /** Every message each launch was given. */
  readonly prompts: SDKUserMessage[];
  account: AccountInfo;
};

const textOf = (message: SDKUserMessage): string => {
  const content = message.message.content;
  if (typeof content === "string") return content;
  return content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
};

export function fakeClaude(): FakeClaude {
  const sessions = new Map<string, SessionEntry[]>();
  const launches: Options[] = [];
  const prompts: SDKUserMessage[] = [];
  const fake: FakeClaude = {
    sessions,
    launches,
    prompts,
    account: { subscriptionType: "Claude Pro", apiProvider: "firstParty" },
    sessionMessages: async (session) => sessions.get(session) ?? [],
    query: ({ prompt, options }): ClaudeQuery => {
      launches.push(options);
      const session = options.resume ?? options.sessionId ?? randomUUID();
      const log = sessions.get(session) ?? [];
      sessions.set(session, log);
      const model = options.model ?? "claude-fake";
      let interrupted: (() => void) | undefined;
      let closed = false;
      const server = (options.mcpServers?.top as { instance?: { connect: (transport: unknown) => Promise<void> } } | undefined)?.instance;
      let client: Client | undefined;
      const tools = async () => {
        if (client || !server) return client;
        const [a, b] = InMemoryTransport.createLinkedPair();
        await server.connect(a);
        client = new Client({ name: "fake-claude", version: "1" });
        await client.connect(b);
        return client;
      };

      async function* messages(): AsyncGenerator<SDKMessage> {
        yield { type: "system", subtype: "init", session_id: session, model } as unknown as SDKMessage;
        for await (const message of prompt) {
          if (closed) return;
          prompts.push(message);
          log.push({ type: "user", uuid: message.uuid ?? randomUUID(), message: message.message });
          const text = textOf(message);
          const calls = [...text.matchAll(/call (\S+) (\{[^}]*\})/g)];
          const answerId = randomUUID();
          let reply = `Claude heard: ${text.trim().split("\n").at(-1) ?? ""}`;
          const stopped = new Promise<"stopped">((resolve) => {
            interrupted = () => resolve("stopped");
          });
          if (/\bhang\b/.test(text)) {
            await stopped;
            return;
          }
          if (calls.length) {
            // Each call goes out as its own message of one answer, and runs as soon as it's out, as Claude Code does.
            const mcp = await tools();
            const running: Promise<string>[] = [];
            for (const call of calls) {
              const id = `toolu_${randomUUID().slice(0, 8)}`;
              const input = JSON.parse(call[2]!) as Record<string, unknown>;
              const block = { type: "tool_use", id, name: `mcp__top__${call[1]}`, input };
              log.push({ type: "assistant", uuid: randomUUID(), message: { role: "assistant", content: [block] } });
              yield {
                type: "assistant",
                parent_tool_use_id: null,
                message: { id: answerId, model, role: "assistant", content: [block], usage: { input_tokens: 10, output_tokens: 5 } },
              } as unknown as SDKMessage;
              const meta = /\bnometa\b/.test(text) ? {} : { _meta: { "claudecode/toolUseId": id } };
              running.push(
                mcp!.callTool({ name: call[1]!, arguments: input, ...meta }).then((r) => {
                  const output = (r as { content: { text?: string }[] }).content.map((part) => part.text ?? "").join("");
                  log.push({
                    type: "user",
                    uuid: randomUUID(),
                    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: output }] },
                  });
                  return `${call[1]} said: ${output}`;
                }),
              );
            }
            const result = await Promise.race([Promise.all(running), stopped]);
            if (result === "stopped" || closed) {
              yield {
                type: "result",
                subtype: "error_during_execution",
                is_error: true,
                errors: ["interrupted"],
                user_message_uuids: [message.uuid],
              } as unknown as SDKMessage;
              continue;
            }
            reply = result.join("; ");
          }
          log.push({ type: "assistant", uuid: randomUUID(), message: { role: "assistant", content: [{ type: "text", text: reply }] } });
          yield {
            type: "assistant",
            parent_tool_use_id: null,
            message: { id: `${answerId}-2`, model, role: "assistant", content: [{ type: "text", text: reply }], usage: { input_tokens: 10, output_tokens: 5 } },
          } as unknown as SDKMessage;
          yield { type: "result", subtype: "success", is_error: false, result: reply, user_message_uuids: [message.uuid] } as unknown as SDKMessage;
        }
      }
      const iterator = messages();
      return {
        [Symbol.asyncIterator]: () => iterator,
        accountInfo: async () => fake.account,
        interrupt: async () => {
          interrupted?.();
        },
        close: () => {
          closed = true;
          interrupted?.();
          void client?.close();
        },
      };
    },
  };
  return fake;
}
