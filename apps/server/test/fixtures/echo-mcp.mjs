import { createInterface } from "node:readline";

const tools = [
  {
    name: "echo",
    description: "Say the text back.",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    annotations: { readOnlyHint: true },
  },
  {
    name: "env",
    description: "Read an environment variable.",
    inputSchema: { type: "object", properties: { name: { type: "string" } } },
  },
  { name: "fail", description: "Always fails.", inputSchema: { type: "object" } },
];

const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
const text = (value, isError) => ({ content: [{ type: "text", text: value }], ...(isError ? { isError: true } : {}) });

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  switch (message.method) {
    case "initialize":
      return reply(message.id, {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "echo", version: "1.0.0" },
      });
    case "ping":
      return reply(message.id, {});
    case "tools/list":
      return reply(message.id, { tools });
    case "tools/call": {
      const { name, arguments: args = {} } = message.params;
      if (name === "echo") return reply(message.id, text(`echo: ${args.text}`));
      if (name === "env") return reply(message.id, text(String(process.env[args.name] ?? "")));
      return reply(message.id, text("it failed", true));
    }
    default:
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } })}\n`);
  }
});
