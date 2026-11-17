/**
 * OpenAI's web search on the Sign in with ChatGPT route: pi-ai's real OpenAI Responses client, signed in
 * with a made-up ChatGPT credential, against recorded-shape SSE streams served by a stand-in `fetch`.
 * Nothing leaves the machine: any other address fails the test.
 */
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { BotError } from "@top/protocol";
import * as Effect from "effect/Effect";
import { afterEach, assert, beforeEach, expect, test, vi } from "vitest";
import type { TopAssistantMessage, TranscriptMessage } from "../src/messages.ts";
import { captureWebSearch, permanentFailure, searchRefusal, searchStep, WEB_SEARCH_SECTION, withWebSearch } from "../src/websearch.ts";
import { toWire } from "../src/wire.ts";
import { type Harness, harness, idle, until } from "./harness.ts";

const MODEL = "openai/gpt-6.1-sol";
const RESPONSES = "https://api.openai.com/v1/responses";

/** A ChatGPT sign-in that never needs refreshing. Not a real token: it only has to not look like an API key. */
class SignedIn implements CredentialStore {
  #credential: Credential = { type: "oauth", access: "test-chatgpt-access", refresh: "test-refresh", expires: Date.now() + 3_600_000 };
  async read(providerId: string) {
    return providerId === "openai" ? this.#credential : undefined;
  }
  async list(): Promise<readonly CredentialInfo[]> {
    return [{ providerId: "openai", type: "oauth" }];
  }
  async modify(_providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>) {
    this.#credential = (await fn(this.#credential)) ?? this.#credential;
    return this.#credential;
  }
  async delete() {}
}

type Event = Record<string, unknown> & { type: string };

/** A Responses API stream, as OpenAI sends it. `hold` waits before the events after it. */
function sse(events: readonly (Event | { hold: Promise<void> })[]): Response {
  const encoder = new TextEncoder();
  let sequence = 0;
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const event of events) {
        if ("hold" in event) {
          await event.hold;
          continue;
        }
        controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number: sequence++ })}\n\n`));
      }
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const usage = {
  input_tokens: 10,
  output_tokens: 5,
  total_tokens: 15,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens_details: { reasoning_tokens: 0 },
};
const done = (id: string): Event => ({ type: "response.completed", response: { id, status: "completed", output: [], usage } });

const ANSWER = "Top keeps bots running ([example.com](https://example.com/top?utm_source=openai)).";
const citation = { type: "url_citation", url: "https://example.com/top?utm_source=openai", title: "Top", start_index: 23, end_index: 82 };

/** A search, then an answer citing what it found: reasoning, the search, the message. */
function searched(hold?: Promise<void>): (Event | { hold: Promise<void> })[] {
  const search = { type: "web_search_call", id: "ws_1" };
  return [
    { type: "response.created", response: { id: "resp_1", status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_1", summary: [] } },
    { type: "response.output_item.done", output_index: 0, item: { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "enc-1" } },
    { type: "response.output_item.added", output_index: 1, item: { ...search, status: "in_progress" } },
    { type: "response.web_search_call.in_progress", output_index: 1, item_id: "ws_1" },
    { type: "response.web_search_call.searching", output_index: 1, item_id: "ws_1" },
    ...(hold ? [{ hold }] : []),
    { type: "response.web_search_call.completed", output_index: 1, item_id: "ws_1" },
    {
      type: "response.output_item.done",
      output_index: 1,
      item: {
        ...search,
        status: "completed",
        action: {
          type: "search",
          queries: ["what is top daemon"],
          sources: [
            { type: "url", url: "https://example.com/top" },
            { type: "url", url: "javascript:alert(1)" },
          ],
        },
      },
    },
    { type: "response.output_item.added", output_index: 2, item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] } },
    { type: "response.output_text.delta", output_index: 2, item_id: "msg_1", content_index: 0, delta: ANSWER },
    {
      type: "response.output_item.done",
      output_index: 2,
      item: {
        type: "message",
        id: "msg_1",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: ANSWER, annotations: [citation, citation, { ...citation, url: "javascript:alert(1)", title: "Not a page" }] }],
      },
    },
    done("resp_1"),
  ];
}

function plain(id: string, text: string): Event[] {
  return [
    { type: "response.created", response: { id, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { type: "message", id: `msg_${id}`, role: "assistant", status: "in_progress", content: [] } },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "message", id: `msg_${id}`, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] },
    },
    done(id),
  ];
}

/** What the stand-in OpenAI got, and what it answers next. */
let requests: Record<string, unknown>[] = [];
let replies: (() => Response)[] = [];

beforeEach(() => {
  requests = [];
  replies = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== RESPONSES) throw new Error(`The test reached for ${url}`);
    requests.push(JSON.parse(String(init?.body)));
    const reply = replies.shift();
    if (!reply) throw new Error("No reply queued");
    return reply();
  });
});
afterEach(() => vi.unstubAllGlobals());

const openai = () => ({ models: builtinModels({ credentials: new SignedIn() }), id: MODEL });

let sent = 0;
async function send(h: Harness, text: string) {
  await h.run(h.daemon.submit(h.bot, `search-${++sent}`, text, "followUp", null));
  await until("the bot to finish", () => idle(h), 10_000);
}
const answers = async (h: Harness) => (await h.entries()).filter((e) => e.kind === "assistant");
const tools = (request: Record<string, unknown> | undefined) => (request?.tools as { type: string }[] | undefined) ?? [];
const items = (request: Record<string, unknown> | undefined) => (request?.input as { type?: string; id?: string; role?: string }[] | undefined) ?? [];

test("signed in with ChatGPT, a bot that may search asks OpenAI's web search on the public Responses route, keeps the search and its citations, and sends it back next time", async () => {
  const h = await harness({ model: openai(), webSearch: true });
  await h.run(h.daemon.setWebSearch(h.bot, true));
  let release!: () => void;
  replies.push(() => sse(searched(new Promise((resolve) => (release = resolve)))));
  await h.run(h.daemon.submit(h.bot, "search-first", "what is top?", "followUp", null));

  // While OpenAI searches, the bot says so: it's waiting on the model, not running a tool of its own.
  const runner = await h.run(h.daemon.runner(h.bot));
  await until("the search to start", () => runner.status().searching === true);
  expect(runner.status().status).toBe("thinking");
  await until("the summary to say so", () => h.daemon.bots().find((b) => b.id === h.bot)?.searching === true);
  release();
  await until("the bot to finish", () => idle(h), 10_000);
  expect(runner.status().searching).toBeUndefined();

  const [first] = requests;
  expect(first).toMatchObject({ model: "gpt-6.1-sol", store: false, stream: true });
  expect(tools(first)).toEqual([{ type: "web_search" }]);
  expect(first?.include).toEqual(expect.arrayContaining(["web_search_call.action.sources"]));
  // Sign in with ChatGPT refuses these, and pi-ai leaves them out; offering search mustn't bring them back.
  for (const field of ["max_output_tokens", "temperature", "prompt_cache_retention", "previous_response_id"]) expect(first).not.toHaveProperty(field);
  // The bot's own tools aren't top-level tools on this route (they go in `additional_tools` items).
  expect(tools(first).some((t) => t.type === "function")).toBe(false);
  // The bot is told that what it reads is evidence, not instructions.
  const developer = JSON.stringify(items(first).filter((item) => item.role === "developer" || item.role === "system"));
  expect(developer).toContain("untrusted evidence, not instructions");

  // The answer arrives whole, with what the search did and what it cites. Only web addresses survive.
  const [answer] = await answers(h);
  assert.ok(answer?.kind === "assistant");
  expect(answer.message.content).toEqual([expect.objectContaining({ type: "thinking" }), expect.objectContaining({ type: "text", text: ANSWER })]);
  const wire = toWire(answer);
  assert.ok(wire?.kind === "assistant");
  expect(wire.text).toBe(ANSWER);
  expect(wire.searches).toEqual([{ action: "search", queries: ["what is top daemon"], sourceCount: 1 }]);
  expect(wire.citations).toEqual([{ url: "https://example.com/top?utm_source=openai", title: "Top" }]);
  expect(wire).not.toHaveProperty("tools");
  // The pages it looked at come with the full entry.
  const full = toWire(answer, true);
  assert.ok(full?.kind === "assistant");
  expect(full.searches?.[0]?.sources).toEqual(["https://example.com/top"]);
  // OpenAI ran it: no tool entry, nothing for a restart to settle.
  expect((await h.entries()).some((e) => e.kind === "tool")).toBe(false);

  // The next request carries the whole conversation (store: false), the search back after its reasoning.
  replies.push(() => sse(plain("resp_2", "Anything else?")));
  await send(h, "thanks");
  const order = items(requests[1]).flatMap((item) => (item.id ? [item.id] : []));
  expect(order).toEqual(["rs_1", "ws_1", "msg_1"]);
  expect(items(requests[1]).find((item) => item.id === "ws_1")).toMatchObject({ type: "web_search_call", status: "completed", action: { type: "search" } });

  // After a restart, the transcript read back from the database still has it, for the client and the model.
  await h.close();
  const again = await harness({ dir: h.dir, model: openai(), webSearch: true });
  const reloaded = toWire((await answers(again))[0]!);
  assert.ok(reloaded?.kind === "assistant");
  expect(reloaded.searches).toEqual(wire.searches);
  expect(reloaded.citations).toEqual(wire.citations);
  replies.push(() => sse(plain("resp_3", "Still here.")));
  await send(again, "still there?");
  expect(items(requests[2]).flatMap((item) => (item.id ? [item.id] : []))).toEqual(["rs_1", "ws_1", "msg_1", "msg_resp_2"]);
  expect(tools(requests[2])).toEqual([{ type: "web_search" }]);
});

test("a bot that may not search doesn't offer it, but earlier searches still go back with their reasoning", async () => {
  const h = await harness({ model: openai(), webSearch: true });
  await h.run(h.daemon.setWebSearch(h.bot, true));
  replies.push(() => sse(searched()));
  await send(h, "what is top?");
  await h.run(h.daemon.setWebSearch(h.bot, false));
  expect(h.daemon.bots().find((b) => b.id === h.bot)?.webSearch).toBe(false);

  replies.push(() => sse(plain("resp_2", "Sure.")));
  await send(h, "and now?");
  expect(tools(requests[1])).toEqual([]);
  expect(requests[1]?.include ?? []).not.toContain("web_search_call.action.sources");
  expect(items(requests[1]).flatMap((item) => (item.id ? [item.id] : []))).toEqual(["rs_1", "ws_1", "msg_1"]);
  // Its instructions no longer mention it.
  const latest = (await h.run(h.store.context(h.bot))).findLast((m) => m.role === "system");
  expect(JSON.stringify(latest)).not.toContain("<web_search>");
});

test("OpenAI refusing web search for the account fails the answer once, saying so, instead of answering without it", async () => {
  const h = await harness({ model: openai(), webSearch: true });
  await h.run(h.daemon.setWebSearch(h.bot, true));
  const refusal = {
    error: {
      message: "This capability is not available for this account.",
      type: "invalid_request_error",
      param: "tools",
      code: "subscription_sharing_unsupported_capability",
    },
  };
  for (let i = 0; i < 4; i++) replies.push(() => new Response(JSON.stringify(refusal), { status: 400, headers: { "content-type": "application/json" } }));
  await send(h, "look it up");
  // The same body would be refused again: no retry.
  expect(requests).toHaveLength(1);
  const [answer] = await answers(h);
  const wire = answer && toWire(answer);
  assert.ok(wire?.kind === "assistant");
  expect(wire.text).toBe("");
  expect(wire.error).toMatch(/^OpenAI refused web search for this account, workspace or model/);
  expect(wire.error).toContain("subscription_sharing_unsupported_capability");
  expect(wire).not.toHaveProperty("citations");
  await until("the bot to need attention", () => h.daemon.bots().find((b) => b.id === h.bot)?.status === "failed");
});

test("a search OpenAI says failed shows as failed, and the answer cites nothing", async () => {
  const h = await harness({ model: openai(), webSearch: true });
  await h.run(h.daemon.setWebSearch(h.bot, true));
  replies.push(() =>
    sse([
      { type: "response.created", response: { id: "resp_f", status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: { type: "web_search_call", id: "ws_f", status: "in_progress" } },
      { type: "response.web_search_call.searching", output_index: 0, item_id: "ws_f" },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: { type: "web_search_call", id: "ws_f", status: "failed", action: { type: "search", queries: ["x"] } },
      },
      ...plain("resp_f", "The search failed, so I couldn't check.")
        .slice(1, 3)
        .map((e) => ({ ...e, output_index: 1 })),
      done("resp_f"),
    ]),
  );
  await send(h, "look it up");
  const wire = toWire((await answers(h))[0]!);
  assert.ok(wire?.kind === "assistant");
  expect(wire.searches).toEqual([{ action: "search", queries: ["x"], failed: true }]);
  expect(wire).not.toHaveProperty("citations");
  expect(wire).not.toHaveProperty("error");
});

test("bots on a model that can't search have nothing to switch, and answer as before", async () => {
  const h = await harness();
  expect(h.daemon.bots()[0]).not.toHaveProperty("webSearch");
  const refused = await h.run(Effect.flip(h.daemon.setWebSearch(h.bot, true)));
  expect(refused).toBeInstanceOf(BotError);
  // The fake model searches only when the request offers it.
  await send(h, "search the web for backoff");
  const wire = toWire((await answers(h))[0]!);
  assert.ok(wire?.kind === "assistant");
  expect(wire.text).toMatch(/can't search the web/);
  expect(wire).not.toHaveProperty("searches");
  expect(requests).toHaveLength(0);
});

test("the fake model plays OpenAI's search through the same hooks, once it's switched on", async () => {
  const h = await harness({ webSearch: true });
  expect(h.daemon.bots()[0]?.webSearch).toBe(false);
  await h.run(h.daemon.setWebSearch(h.bot, true));
  await until("the summary to show it", () => h.daemon.bots()[0]?.webSearch === true);
  await send(h, "search the web for retry backoff");
  const wire = toWire((await answers(h))[0]!);
  assert.ok(wire?.kind === "assistant");
  expect(wire.searches?.map((s) => s.action)).toEqual(["search", "open_page"]);
  expect(wire.citations?.length).toBe(2);
  // OpenAI refusing it, as the fake plays it.
  await send(h, "search the web for jitter refused");
  const failed = toWire((await answers(h)).at(-1)!);
  assert.ok(failed?.kind === "assistant");
  expect(failed.error).toMatch(/^OpenAI refused web search/);
});

// ── the pieces ───────────────────────────────────────────────────────────────────

test("compacting a bot that may search keeps search in the summary request, so it starts like the request before it", async () => {
  const h = await harness({ model: openai(), webSearch: true, compactAtTokens: 10 });
  await h.run(h.daemon.setWebSearch(h.bot, true));
  replies.push(() => sse(searched()));
  await send(h, "what is top?");
  // The next message finds the conversation over the limit: first the summary, then the answer.
  replies.push(() => sse(plain("resp_summary", "## Goal\nKnow what Top is.")));
  replies.push(() => sse(plain("resp_2", "Anything else?")));
  await send(h, "thanks");

  const [first, summary, next] = requests;
  // The same tools, and the first request's items word for word, then its answer with the search: the cache covers it.
  expect(tools(summary)).toEqual(tools(first));
  expect(items(summary).slice(0, items(first).length)).toEqual(items(first));
  expect(items(summary).flatMap((item) => (item.id ? [item.id] : []))).toEqual(["rs_1", "ws_1", "msg_1"]);
  expect(JSON.stringify(items(summary).at(-1))).toContain("being compacted");
  // Then the bot goes on from the summary, still able to search.
  expect(tools(next)).toEqual([{ type: "web_search" }]);
  expect(JSON.stringify(items(next))).toContain("Know what Top is.");
  expect((await h.entries()).some((e) => e.kind === "notice" && e.message.text.startsWith("Compacted"))).toBe(true);
});

const assistant = (webSearch: TopAssistantMessage["webSearch"]): TranscriptMessage =>
  ({ role: "assistant", content: [], stopReason: "stop", timestamp: 0, webSearch }) as unknown as TranscriptMessage;
const item = (id: string) => ({ type: "web_search_call" as const, id, status: "completed" });

test("earlier searches go back next to the item they followed, and only when it's there", () => {
  const context = [
    assistant({
      searches: [
        { item: item("ws_a"), after: "rs_1" },
        { item: item("ws_b"), after: "ws_a" },
        { item: item("ws_first"), before: "msg_1" },
        { item: item("ws_orphan"), after: "rs_gone" },
      ],
      citations: [],
    }),
  ];
  const input = [{ role: "user" }, { type: "reasoning", id: "rs_1" }, { type: "message", id: "msg_1" }];
  const out = withWebSearch({ input, tools: [{ type: "function", name: "x" }], include: ["reasoning.encrypted_content"] }, context, true) as {
    input: { id?: string }[];
    tools: unknown[];
    include: string[];
  };
  expect(out.input.map((i) => i.id)).toEqual([undefined, "rs_1", "ws_a", "ws_b", "ws_first", "msg_1"]);
  expect(out.tools).toEqual([{ type: "function", name: "x" }, { type: "web_search" }]);
  expect(out.include).toEqual(["reasoning.encrypted_content", "web_search_call.action.sources"]);
  // The request pi-ai built is left as it was.
  expect(input).toHaveLength(3);
  // Not an object with input: left to pi-ai.
  expect(withWebSearch("nope", context, true)).toBeUndefined();
});

test("searches in a row with nothing before them go back before the message they led to, in order", () => {
  const capture = captureWebSearch(() => {});
  const done = (index: number, item: Record<string, unknown>) => capture.event({ type: "response.output_item.done", output_index: index, item });
  done(0, { type: "web_search_call", id: "ws_a", status: "completed" });
  done(1, { type: "web_search_call", id: "ws_b", status: "completed" });
  done(2, { type: "message", id: "msg_1", content: [] });
  const context = [assistant(capture.record())];
  // pi-ai's next request has the message, not the searches: both go back before it.
  const out = withWebSearch({ input: [{ role: "user" }, { type: "message", id: "msg_1" }] }, context, false) as { input: { id?: string }[] };
  expect(out.input.map((i) => i.id)).toEqual([undefined, "ws_a", "ws_b", "msg_1"]);
});

test("only web addresses become links: citations, sources and opened pages", () => {
  const seen: boolean[] = [];
  const capture = captureWebSearch((on) => seen.push(on));
  capture.event({ type: "response.web_search_call.searching" });
  capture.event({ type: "response.output_item.added", output_index: 0, item: { type: "web_search_call", id: "ws_1" } });
  capture.event({
    type: "response.output_item.done",
    output_index: 0,
    item: { type: "web_search_call", id: "ws_1", status: "completed", action: { type: "open_page", url: "file:///etc/passwd" } },
  });
  capture.event({
    type: "response.output_item.done",
    output_index: 1,
    item: {
      type: "message",
      id: "msg_1",
      content: [
        {
          type: "output_text",
          annotations: [
            { type: "url_citation", url: "data:text/html,hi", title: "x" },
            { type: "url_citation", url: "https://example.org/a", title: "  " },
          ],
        },
      ],
    },
  });
  const record = capture.record();
  expect(seen).toEqual([true, false]);
  expect(record?.citations).toEqual([{ url: "https://example.org/a", title: "example.org" }]);
  expect(record?.searches).toEqual([{ item: expect.objectContaining({ id: "ws_1" }), before: "msg_1" }]);
  expect(searchStep(record!.searches[0]!.item, false)).toEqual({ action: "open_page" });
  expect(
    searchStep(
      { type: "web_search_call", id: "w", status: "incomplete", action: { type: "find_in_page", url: "https://example.org/a", pattern: "jitter" } },
      false,
    ),
  ).toEqual({ action: "find_in_page", url: "https://example.org/a", pattern: "jitter", failed: true });
  // Nothing searched or cited: nothing kept.
  expect(captureWebSearch(() => {}).record()).toBeUndefined();
  expect(WEB_SEARCH_SECTION).toContain("untrusted evidence");
});

test("only OpenAI's capability refusal of the tool is called a web search refusal, and that is never retried", () => {
  const refused = `OpenAI API error (400): {"param":"tools","code":"subscription_sharing_unsupported_capability"}`;
  expect(searchRefusal(refused)).toMatch(/^OpenAI refused web search/);
  expect(permanentFailure(refused)).toBe(true);
  // Another refused capability (a model): not blamed on web search, still not retried.
  const model = `OpenAI API error (400): {"param":"model","code":"subscription_sharing_unsupported_capability"}`;
  expect(searchRefusal(model)).toBeUndefined();
  expect(permanentFailure(model)).toBe(true);
  // Anything else that mentions web search isn't a refusal: it keeps its own words, and the usual retries.
  for (const other of [
    "Item 'ws_1' of type 'web_search_call' was provided without its required 'reasoning' item.",
    `OpenAI API error (400): {"message":"web_search is not supported with this model","param":"tools","code":null}`,
  ]) {
    expect(searchRefusal(other)).toBeUndefined();
    expect(permanentFailure(other)).toBe(false);
  }
});
