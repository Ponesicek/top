import type { SimpleStreamOptions } from "@earendil-works/pi-ai";
import { type FauxResponseFactory, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { COLLAR } from "./collar/names.ts";

const ASK_PERMISSION = `${COLLAR}__ask_permission`;

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
  if (Math.random() < 0.3) words[Math.floor(Math.random() * n)] = `\`${pick(WORDS)}()\``;
  if (Math.random() < 0.2) words[Math.floor(Math.random() * n)] = `**${pick(WORDS)}**`;
  const text = words.join(" ");
  return `${text[0]!.toUpperCase() + text.slice(1)}.`;
}

function paragraph(): string {
  return Array.from({ length: 2 + Math.floor(Math.random() * 4) }, () => sentence()).join(" ");
}

export type Context = Parameters<FauxResponseFactory>[0];
export type RequestOptions = Parameters<FauxResponseFactory>[1];
type ContextMessage = Context["messages"][number];

function contentText(message: ContextMessage | undefined): string {
  if (!message || !("content" in message)) return "";
  const content = message.content as string | { type: string; text?: string }[];
  if (typeof content === "string") return content;
  return content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("");
}

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
type JsonObject = Parameters<typeof fauxToolCall>[1];
const jsonObject = Schema.decodeOption(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)));
const call = (name: string, args: JsonObject) => fauxToolCall(name, args, { id: `call_${Date.now().toString(36)}_${++callCounter}` });

export function toolFor(prompt: string): ReturnType<typeof call> | undefined {
  const named = /\bcall ([A-Za-z0-9-]+__[A-Za-z0-9_-]+)(?:\s+(\{.*\}))?/s.exec(prompt);
  if (named) {
    const args = named[2] ? Option.getOrElse(jsonObject(named[2]), () => ({})) : {};
    return call(named[1]!, args);
  }
  const asking = /\bask (?:for )?permission(?: to)?\s+(.+)/is.exec(prompt);
  if (asking) return call(ASK_PERMISSION, { action: asking[1]!.trim(), reason: "You asked me to check with you first." });
  const text = prompt.toLowerCase();
  const secs = /(\d+(?:\.\d+)?)\s*s\b/.exec(text)?.[1];
  const seconds: Record<string, number> = secs === undefined ? {} : { seconds: Number(secs) };
  if (/\bcrash\b/.test(text)) return call("crash_daemon", {});
  if (/\bdeploy\b/.test(text)) return call("deploy", { service: /deploy (?:the )?([a-z-]+)/.exec(text)?.[1] ?? "web", ...seconds });
  if (/\bemail\b/.test(text)) return call("send_email", { to: "team@example.com", subject: "Status update", ...seconds });
  if (/\breport\b/.test(text)) return call("write_report", {});
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

const FAKE_PAGES = [
  { url: "https://example.com/guides/backoff", title: "Retry with backoff · Example Guides" },
  { url: "https://example.org/notes/websocket-reconnects", title: "Notes on WebSocket reconnects" },
  { url: "https://www.example.net/blog/sqlite-wal", title: "SQLite WAL in practice" },
  { url: "https://example.com/reference/jitter", title: "Jitter, explained" },
] as const;

let searchCounter = 0;
const pause = (ms: number, signal: AbortSignal | undefined) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

async function searchTheWeb(prompt: string, options: SimpleStreamOptions | undefined) {
  const offered = (await options?.onPayload?.({ input: [], tools: [] }, undefined as never)) as { tools?: { type?: string }[] } | undefined;
  if (!offered?.tools?.some((tool) => tool.type === "web_search"))
    return fauxAssistantMessage("I can't search the web: web search is off for me. You can switch it on in Settings.");
  const query =
    /search the web (?:for|about)\s+(.+)/is
      .exec(prompt)?.[1]
      ?.replace(/\s+(refused|fails)\s*$/i, "")
      .trim() || "the question";
  if (/\brefused\b/i.test(prompt))
    return fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage: `OpenAI API error (400): {"message":"Web search is not available for this account.","type":"invalid_request_error","param":"tools","code":"subscription_sharing_unsupported_capability"}`,
    });
  const emit = async (event: Record<string, unknown>) => options?.onProviderStreamEvent?.(event, undefined as never);
  const n = ++searchCounter;
  const fails = /\bfails\b/i.test(prompt);
  await emit({ type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: `rs_fake${n}` } });
  await emit({ type: "response.output_item.done", output_index: 0, item: { type: "reasoning", id: `rs_fake${n}`, summary: [] } });
  await emit({ type: "response.output_item.added", output_index: 1, item: { type: "web_search_call", id: `ws_fake${n}`, status: "in_progress" } });
  await emit({ type: "response.web_search_call.in_progress", output_index: 1, item_id: `ws_fake${n}` });
  await emit({ type: "response.web_search_call.searching", output_index: 1, item_id: `ws_fake${n}` });
  await pause(3_000, options?.signal);
  if (fails) {
    await emit({
      type: "response.output_item.done",
      output_index: 1,
      item: { type: "web_search_call", id: `ws_fake${n}`, status: "failed", action: { type: "search", queries: [query] } },
    });
    return fauxAssistantMessage(`I tried to search the web for “${query}”, but the search failed, so I haven't checked anything online. ${sentence()}`);
  }
  await emit({ type: "response.web_search_call.completed", output_index: 1, item_id: `ws_fake${n}` });
  await emit({
    type: "response.output_item.done",
    output_index: 1,
    item: {
      type: "web_search_call",
      id: `ws_fake${n}`,
      status: "completed",
      action: { type: "search", queries: [query], sources: FAKE_PAGES.map((page) => ({ type: "url", url: page.url })) },
    },
  });
  const [first, second] = [FAKE_PAGES[0], FAKE_PAGES[1]];
  await emit({
    type: "response.output_item.done",
    output_index: 2,
    item: { type: "web_search_call", id: `ws_fake${n}b`, status: "completed", action: { type: "open_page", url: first.url } },
  });
  const cited = (page: (typeof FAKE_PAGES)[number]) => `([${new URL(page.url).hostname}](${page.url}?utm_source=openai))`;
  const lead = `On “${query}”: start with a short delay and double it after each failure, up to a cap `;
  const middle = `. Add random jitter so clients that dropped together don't all come back at once `;
  const text = `${lead}${cited(first)}${middle}${cited(second)}.\n\n${paragraph()}`;
  const span = (page: (typeof FAKE_PAGES)[number]) => {
    const start = text.indexOf(cited(page));
    return { type: "url_citation", url: `${page.url}?utm_source=openai`, title: page.title, start_index: start, end_index: start + cited(page).length };
  };
  await emit({
    type: "response.output_item.done",
    output_index: 3,
    item: { type: "message", id: `msg_fake${n}`, content: [{ type: "output_text", text, annotations: [span(first), span(second)] }] },
  });
  return fauxAssistantMessage(text);
}

export function respond(context: Context, options?: SimpleStreamOptions) {
  const results = trailingToolResults(context);
  if (results.length) {
    const lines = results.map((r) => `- **${"toolName" in r ? r.toolName : "tool"}**: ${contentText(r)}`).join("\n");
    if (results.every((r) => "toolName" in r && r.toolName === ASK_PERMISSION && !r.isError))
      return fauxAssistantMessage("I've asked you. I'll wait for your answer before I do it.");
    return fauxAssistantMessage(`Done. Here is what happened:\n\n${lines}\n\n${sentence()}`);
  }
  const prompt = lastUserText(context);
  if (/^\[Permission\]/.test(prompt)) return fauxAssistantMessage(`Got your answer. ${prompt.replace(/^\[Permission\] /, "")}`);
  if (/^\[(Wake-up|Background job)/.test(prompt)) return fauxAssistantMessage(`Noted: ${prompt.split("\n")[0]}`);
  const failure = () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "Provider overloaded (test)" });
  if (/\bfail always\b/i.test(prompt)) return failure();
  if (/\bfail once\b/i.test(prompt) && !failedOnce.has(prompt)) {
    failedOnce.add(prompt);
    return failure();
  }
  if (/\bsearch the web\b/i.test(prompt)) return searchTheWeb(prompt, options);
  const tool = toolFor(prompt);
  if (tool) {
    const said = tool.name === ASK_PERMISSION ? "I'll check with you first." : `On it: ${tool.name.replace("_", " ")}.`;
    return fauxAssistantMessage([fauxText(said), tool], { stopReason: "toolUse" });
  }
  return fauxAssistantMessage(fakeAnswer(prompt));
}

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
      parts.push(`\`\`\`${lang}\n${code}\n\`\`\``);
    } else {
      parts.push(
        "| step | p50 | p99 |\n|---|---|---|\n" +
          Array.from({ length: 3 }, () => `| ${pick(WORDS)} | ${(Math.random() * 8).toFixed(1)} ms | ${(Math.random() * 30).toFixed(1)} ms |`).join("\n"),
      );
    }
  }
  return parts.join("\n\n");
}

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

export const makeFakeModelProvider = (tokensPerSecond: number, onRequest?: (context: Context, options: RequestOptions) => void) =>
  Effect.gen(function* () {
    const faux = fauxProvider({
      provider: FAKE_PROVIDER,
      models: [{ id: FAKE_MODEL, name: "Top fake model", contextWindow: 1_000_000, maxTokens: 65_536 }],
      tokensPerSecond,
      tokenSize: { min: 3, max: 6 },
    });
    const factory: FauxResponseFactory = (context, options) => {
      onRequest?.(context, options);
      return respond(context, options);
    };
    const topUp = Effect.sync(() => {
      if (faux.getPendingResponseCount() < 256) faux.appendResponses(Array.from({ length: 1024 }, () => factory));
    });
    yield* topUp;
    yield* Effect.forkScoped(Effect.repeat(topUp, Schedule.spaced(Duration.seconds(1))));
    return faux;
  });
