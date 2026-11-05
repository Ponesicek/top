/**
 * Fake bots for development and the performance spike: Pi AI's faux provider, scripted to stream
 * markdown answers (prose, lists, code blocks, tables) at a fixed token rate. Everything above the
 * model is real Pi Durable: commits, views, watches, the inbox.
 */
import { fauxAssistantMessage, fauxProvider, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";

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
    `const watch = await conversation.watch(context, transcript.resume);
watch.start(async (call) => {
  if (call.kind !== "value") return;
  socket.send(JSON.stringify({ t: "ops", sub, ops: encoder.encode(call.ops) }));
  await drained(socket);
});`,
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

function lastUserText(context: Parameters<FauxResponseFactory>[0]): string {
  for (let i = context.messages.length - 1; i >= 0; i--) {
    const message = context.messages[i]!;
    if (message.role !== "user") continue;
    if (typeof message.content === "string") return message.content;
    return message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
  }
  return "";
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
  const respond: FauxResponseFactory = (context) => fauxAssistantMessage(fakeAnswer(lastUserText(context)));
  // The faux provider consumes one scripted step per request; keep the script topped up forever.
  const topUp = () => {
    if (faux.getPendingResponseCount() < 256) faux.appendResponses(Array.from({ length: 1024 }, () => respond));
  };
  topUp();
  const timer = setInterval(topUp, 1_000);
  timer.unref();
  return faux;
}
