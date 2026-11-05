/**
 * Fake bots for development, tests and benchmarks: Pi AI's faux provider, scripted to answer in
 * markdown (prose, lists, code blocks, tables) at a fixed token rate, and to call tools when a message
 * asks for one ("deploy web", "email the team", "check status", "crash"). Everything above the model is
 * the real daemon: storage, the agent loop, tools, recovery.
 */
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";

export const FAKE_PROVIDER = "faux";
export const FAKE_MODEL = "top-fake";

export const BOT_NAMES = ["Atlas", "Juniper", "Moss", "Quill", "Vesper"] as const;

const WORDS =
  "the a daemon bot queue socket view commit transcript client resume window token stream frame render batch op snapshot task tool cache latency budget phone desktop server durable state replay steer follow-up inbox harness sqlite wal checkpoint backoff jitter heartbeat diff patch merge gap cursor page virtualized row height measure scroll anchor optimistic pending ack request id idempotent".split(
    " ",
  );

const CODE_SAMPLES: readonly (readonly [string, string])[] = [
  [
    "ts",
    `const missing = store.after(bot, frame.after, limit + 1);
const gap = missing.length > limit ? { after: frame.after, before: missing[1]!.seq } : undefined;
send(socket, { t: "sync", bot, entries: missing.slice(-limit).map(toWire), gap });`,
  ],
  [
    "rust",
    `fn backoff(attempt: u32) -> Duration {
    let base = Duration::from_millis(250);
    let capped = base * 2u32.saturating_pow(attempt.min(6));
    capped.mul_f64(rand::random::<f64>() * 0.5 + 0.75)
}`,
  ],
  [
    "bash",
    `pnpm server -- --load
pnpm desktop
# kill the daemon mid-turn, then start it again:
kill -9 $(pgrep -f apps/server) && pnpm server`,
  ],
  [
    "json",
    `{
  "t": "submit",
  "conversationId": "c_01",
  "requestId": "4f1c…",
  "content": "run the tests",
  "whenBusy": "steer"
}`,
  ],
];

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)]!;
}

function sentence(min = 6, max = 18): string {
  const n = min + Math.floor(Math.random() * (max - min));
  const words = Array.from({ length: n }, () => pick(WORDS));
  if (Math.random() < 0.3) words[Math.floor(Math.random() * n)] = "`" + pick(WORDS) + "()`";
  if (Math.random() < 0.2) words[Math.floor(Math.random() * n)] = "**" + pick(WORDS) + "**";
  const text = words.join(" ");
  return text[0]!.toUpperCase() + text.slice(1) + ".";
}

function paragraph(): string {
  return Array.from({ length: 2 + Math.floor(Math.random() * 4) }, () => sentence()).join(" ");
}

type Context = Parameters<FauxResponseFactory>[0];
type ContextMessage = Context["messages"][number];

function contentText(message: ContextMessage | undefined): string {
  if (!message || !("content" in message)) return "";
  const content = message.content as string | { type: string; text?: string }[];
  if (typeof content === "string") return content;
  return content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("");
}

/** Tool results since the last assistant message, newest last. */
function trailingToolResults(context: Context): ContextMessage[] {
  const results: ContextMessage[] = [];
  for (let i = context.messages.length - 1; i >= 0; i--) {
    const message = context.messages[i]!;
    if (message.role !== "toolResult") break;
    results.unshift(message);
  }
  return results;
}

let callCounter = 0;
const call = (name: string, args: Record<string, string | number>) => fauxToolCall(name, args, { id: `call_${Date.now().toString(36)}_${++callCounter}` });

/** The tool a message asks for, if any: "deploy web 3s", "email the team", "check status", "crash". */
export function toolFor(prompt: string): ReturnType<typeof call> | undefined {
  const text = prompt.toLowerCase();
  const secs = /(\d+(?:\.\d+)?)\s*s\b/.exec(text)?.[1];
  const seconds: Record<string, number> = secs === undefined ? {} : { seconds: Number(secs) };
  if (/\bcrash\b/.test(text)) return call("crash_daemon", {});
  if (/\bdeploy\b/.test(text)) return call("deploy", { service: /deploy (?:the )?([a-z-]+)/.exec(text)?.[1] ?? "web", ...seconds });
  if (/\bemail\b/.test(text)) return call("send_email", { to: "team@example.com", subject: "Status update", ...seconds });
  if (/\bstatus\b/.test(text)) return call("check_status", { target: "The build", ...seconds });
  return undefined;
}

function lastUserText(context: Context): string {
  for (let i = context.messages.length - 1; i >= 0; i--) {
    const message = context.messages[i]!;
    if (message.role === "user") return contentText(message);
  }
  return "";
}

const failedOnce = new Set<string>();

/** One scripted model response: a tool call when the message asks for one, else an answer. "fail once" and "fail always" fail the request. */
export function respond(context: Context) {
  const results = trailingToolResults(context);
  if (results.length) {
    const lines = results.map((r) => `- **${"toolName" in r ? r.toolName : "tool"}**: ${contentText(r)}`).join("\n");
    return fauxAssistantMessage(`Done. Here is what happened:\n\n${lines}\n\n${sentence()}`);
  }
  const prompt = lastUserText(context);
  const failure = () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "Provider overloaded (test)" });
  if (/\bfail always\b/i.test(prompt)) return failure();
  if (/\bfail once\b/i.test(prompt) && !failedOnce.has(prompt)) {
    failedOnce.add(prompt);
    return failure();
  }
  const tool = toolFor(prompt);
  if (tool) return fauxAssistantMessage([fauxText(`On it: ${tool.name.replace("_", " ")}.`), tool], { stopReason: "toolUse" });
  return fauxAssistantMessage(fakeAnswer(prompt));
}

/** One markdown answer, roughly 150–700 tokens. */
export function fakeAnswer(prompt: string): string {
  const parts: string[] = [];
  const topic = prompt.trim().split("\n")[0]!.slice(0, 80);
  parts.push(topic ? `On “${topic}”: ${sentence()}` : sentence());
  const blocks = 2 + Math.floor(Math.random() * 4);
  for (let i = 0; i < blocks; i++) {
    const roll = Math.random();
    if (roll < 0.4) parts.push(paragraph());
    else if (roll < 0.6) parts.push(Array.from({ length: 3 + Math.floor(Math.random() * 3) }, () => `- ${sentence(4, 10)}`).join("\n"));
    else if (roll < 0.85) {
      const [lang, code] = pick(CODE_SAMPLES);
      parts.push("```" + lang + "\n" + code + "\n```");
    } else {
      parts.push(
        "| step | p50 | p99 |\n|---|---|---|\n" +
          Array.from({ length: 3 }, () => `| ${pick(WORDS)} | ${(Math.random() * 8).toFixed(1)} ms | ${(Math.random() * 30).toFixed(1)} ms |`).join("\n"),
      );
    }
  }
  return parts.join("\n\n");
}

/** Load prompts that make the bots use tools (`--tools`). */
export const TOOL_PROMPTS = ["Check status of the build", "Deploy the web service 1s", "Email the team the status 1s"] as const;

export const FAKE_PROMPTS = [
  "Summarize what changed in the build since this morning",
  "Why does the reconnect test flake on CI?",
  "Draft a plan for moving the socket into a worker",
  "Check the queue depth and tell me if anything is stuck",
  "Write a backoff helper with jitter",
  "What did the nightly job report?",
  "Compare SQLite WAL with JSONL storage for long-running bots",
  "List the open TODOs in the client package",
] as const;

export function createFakeModelProvider(tokensPerSecond: number) {
  const faux = fauxProvider({
    provider: FAKE_PROVIDER,
    models: [{ id: FAKE_MODEL, name: "Top fake model", contextWindow: 1_000_000, maxTokens: 65_536 }],
    tokensPerSecond,
    tokenSize: { min: 3, max: 6 },
  });
  const factory: FauxResponseFactory = (context) => respond(context);
  // The faux provider consumes one scripted step per request; keep the script topped up forever.
  const topUp = () => {
    if (faux.getPendingResponseCount() < 256) faux.appendResponses(Array.from({ length: 1024 }, () => factory));
  };
  topUp();
  const timer = setInterval(topUp, 1_000);
  timer.unref();
  return faux;
}
