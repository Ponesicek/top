#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

if (process.argv[2] === "--version") {
  console.log("codex-cli 0.0.0-fake");
  process.exit(0);
}

const log = (entry) => process.env.FAKE_CODEX_LOG && appendFileSync(process.env.FAKE_CODEX_LOG, `${JSON.stringify(entry)}\n`);
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
let nextServerId = 1000;
const waiting = new Map();
let turns = 0;
let active;

const finish = (threadId, turnId, status, text) => {
  if (text) send({ method: "item/completed", params: { threadId, turnId, item: { type: "agentMessage", id: `msg-${turnId}`, text, phase: "final_answer" } } });
  send({
    method: "thread/tokenUsage/updated",
    params: { threadId, turnId, tokenUsage: { total: { inputTokens: 1200, outputTokens: 34, cachedInputTokens: 1000 } } },
  });
  send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status, error: status === "failed" ? { message: "the model refused" } : null } } });
  active = undefined;
};

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  log(message);
  if (message.method === undefined) {
    const resolve = waiting.get(message.id);
    waiting.delete(message.id);
    resolve?.(message.result);
    return;
  }
  const { id, method, params } = message;
  const reply = (result) => send({ id, result });
  switch (method) {
    case "initialize":
      return reply({ userAgent: "fake", codexHome: "/tmp/fake", platformFamily: "unix", platformOs: "linux" });
    case "initialized":
      return;
    case "account/read":
      return reply(
        process.env.FAKE_CODEX_LOGGED_OUT ? { account: null, requiresOpenaiAuth: true } : { account: { type: "chatgpt" }, requiresOpenaiAuth: true },
      );
    case "thread/start":
      return reply({ thread: { id: "thr_fake" }, model: "gpt-fake" });
    case "thread/resume":
    case "thread/fork":
      return reply({ thread: { id: method === "thread/fork" ? "thr_branch" : params.threadId }, model: "gpt-fake" });
    case "turn/start": {
      const turnId = `turn_${++turns}`;
      const threadId = params.threadId;
      active = turnId;
      reply({ turn: { id: turnId, status: "inProgress" } });
      send({ method: "turn/started", params: { threadId, turn: { id: turnId, status: "inProgress" } } });
      const text = params.input.find((i) => i.type === "text")?.text ?? "";
      if (text.includes("approve")) {
        const requestId = nextServerId++;
        waiting.set(requestId, (result) => {
          send({ method: "serverRequest/resolved", params: { threadId, requestId } });
          send({
            method: "item/completed",
            params: {
              threadId,
              turnId,
              item: { type: "commandExecution", id: "cmd1", command: "npm test", exitCode: 0, status: "completed", aggregatedOutput: "ok" },
            },
          });
          finish(threadId, turnId, "completed", `decision: ${typeof result.decision === "string" ? result.decision : JSON.stringify(result.decision)}`);
        });
        send({
          id: requestId,
          method: "item/commandExecution/requestApproval",
          params: { threadId, turnId, itemId: "cmd1", command: "npm test", cwd: "/w", reason: "needs network" },
        });
        return;
      }
      if (text.includes("question")) {
        const requestId = nextServerId++;
        waiting.set(requestId, (result) => finish(threadId, turnId, "completed", `answer: ${JSON.stringify(result.answers)}`));
        send({
          id: requestId,
          method: "item/tool/requestUserInput",
          params: {
            threadId,
            turnId,
            itemId: "q1",
            questions: [
              {
                id: "color",
                header: "Colour",
                question: "Which colour?",
                isOther: true,
                isSecret: false,
                options: [{ label: "red", description: "warm" }, { label: "blue" }],
              },
            ],
          },
        });
        return;
      }
      if (text.includes("wait")) return;
      if (text.includes("fail")) return setTimeout(() => finish(threadId, turnId, "failed"), 10);
      setTimeout(() => {
        send({
          method: "item/completed",
          params: { threadId, turnId, item: { type: "fileChange", id: "fc", changes: [{ path: "a.ts", kind: { type: "update" } }], status: "completed" } },
        });
        finish(threadId, turnId, "completed", `hello: ${text}`);
      }, 10);
      return;
    }
    case "turn/steer":
      return reply({ turnId: params.expectedTurnId });
    case "turn/interrupt":
      reply({});
      if (active) finish(params.threadId, active, "interrupted");
      return;
    default:
      return send({ id, error: { code: -32601, message: `unknown ${method}` } });
  }
});
