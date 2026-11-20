import type { ConversationSnapshot, Entry, TranscriptItem, WaitingTask } from "@top/client";
import { describe, expect, it } from "vitest";
import { committedRows, displayRows, tailRows, taskQuestionRows } from "../src/rows.ts";

const BOT = 3;
const ASK = "collar__ask_permission";
let seq = 0;
const entry = (e: Record<string, unknown>): TranscriptItem => ({ kind: "entry", entry: { seq: ++seq, bot: BOT, at: 1_000 + seq, ...e } as Entry });
const said = () => entry({ kind: "assistant", text: "I'll check with you first.", tools: [{ id: "call_1", name: ASK, summary: "action: deploy web" }] });
const asked = (id: number, toolCallId = "call_1") =>
  entry({
    kind: "tool",
    toolCallId,
    name: ASK,
    text: "Asked the user: deploy web.",
    ask: { kind: "permission", id, action: "deploy web", reason: "It's Friday." },
  });
const settled = (request: number, answer: string, reply?: unknown) => entry({ kind: "answer", request, answer, ...(reply ? { reply } : {}) });
const message = (request: number) =>
  entry({ kind: "user", text: "[Permission] The user allowed: deploy web.", source: "answer", requestId: `answer:${request}` });
const cards = (items: TranscriptItem[]) => displayRows(committedRows(items)).filter((r) => r.kind === "ask");

describe("ask rows", () => {
  it("waits where the bot asked, in place of the call's tool step", () => {
    const rows = displayRows(committedRows([said(), asked(1)]), true);
    expect(rows.map((r) => r.kind)).toEqual(["assistant", "ask"]);
    expect(rows[1]).toMatchObject({ bot: BOT, ask: { id: 1, action: "deploy web", reason: "It's Friday." } });
    expect(rows[1]).not.toHaveProperty("answer");
  });

  it("settles from the entry naming its request: allowed, denied or withdrawn; that entry and the bot's message show nothing", () => {
    for (const answer of ["allowed", "denied", "withdrawn"]) {
      const items = [said(), asked(5), settled(5, answer), ...(answer === "withdrawn" ? [] : [message(5)])];
      const rows = displayRows(committedRows(items), true);
      expect(rows.map((r) => r.kind)).toEqual(["assistant", "ask"]);
      expect(rows[1]).toMatchObject({ ask: { id: 5 }, answer });
    }
  });

  it("a provider reusing a tool-call id in a later turn doesn't settle the new request with the old answer", () => {
    const items = [said(), asked(1, "call_1"), settled(1, "allowed"), message(1), said(), asked(2, "call_1")];
    const [first, second] = cards(items);
    expect(first).toMatchObject({ ask: { id: 1 }, answer: "allowed" });
    expect(second).toMatchObject({ ask: { id: 2 } });
    expect(second).not.toHaveProperty("answer");
  });

  it("a call refused before anyone was asked (bad arguments) is an ordinary failed tool step, not a request", () => {
    const refused = entry({ kind: "tool", toolCallId: "call_1", name: ASK, text: "Say what you want to do in `action`.", isError: true });
    expect(displayRows(committedRows([said(), refused]), true).map((r) => r.kind)).toEqual(["assistant", "toolgroup"]);
  });

  it("shows with tool steps hidden too: it's a question, not a step", () => {
    expect(displayRows(committedRows([said(), asked(1)]), false).map((r) => r.kind)).toEqual(["assistant", "ask"]);
  });

  it("a question settles with the reply the user gave, which the card shows; the answer that reached the bot shows nothing", () => {
    const question = entry({
      kind: "tool",
      toolCallId: "call_1",
      name: "collar__ask_question",
      text: "Asked the user: Which environment?",
      ask: { kind: "question", id: 7, question: "Which environment?", options: [{ label: "Staging" }, { label: "Production" }], other: true },
    });
    const rows = displayRows(committedRows([said(), question, settled(7, "answered", { choices: [0], text: "after 5pm" }), message(7)]), true);
    expect(rows.map((r) => r.kind)).toEqual(["assistant", "ask"]);
    expect(rows[1]).toMatchObject({ ask: { kind: "question", id: 7 }, answer: "answered", reply: { choices: [0], text: "after 5pm" } });
  });

  it("a secret request settles as saved or declined, and nothing about the value is in the row", () => {
    const secret = entry({
      kind: "tool",
      toolCallId: "call_1",
      name: "collar__request_secret",
      text: "Asked the user for GitHub token.",
      ask: { kind: "secret", id: 8, label: "GitHub token", reason: "To open the PR." },
    });
    for (const answer of ["saved", "declined"]) {
      const [row] = cards([said(), secret, settled(8, answer)]);
      expect(row).toEqual({
        kind: "ask",
        key: expect.any(String),
        bot: BOT,
        ask: { kind: "secret", id: 8, label: "GitHub token", reason: "To open the PR." },
        answer,
      });
    }
  });

  it("keeps the same row object while nothing about it changes, so it doesn't re-render", () => {
    const items = [said(), asked(9)];
    const first = cards(items)[0];
    expect(cards([...items])[0]).toBe(first);
    const answered = cards([...items, settled(9, "denied")])[0];
    expect(answered).not.toBe(first);
    expect(cards([...items, settled(9, "denied"), message(9)])[0]).toBe(answered);
  });
});

describe("messages from Top", () => {
  const wake = () =>
    entry({ kind: "user", text: "[Wake-up] check the deploy\n\nYou set this wake-up at 9:00 for 9:30. The user didn't send it.", source: "wake" });
  const reply = () => entry({ kind: "assistant", text: "The deploy finished." });

  it("a wake-up that came due shows nothing but ends the turn before it; the bot's reply to it shows", () => {
    const rows = displayRows(committedRows([entry({ kind: "assistant", text: "I'll look at 9:30." }), wake(), reply()]));
    expect(rows.map((r) => r.kind)).toEqual(["assistant", "wake", "assistant"]);
    expect(rows[1]).not.toHaveProperty("text");
    expect(rows.map((r) => (r.kind === "assistant" ? r.text : ""))).toEqual(["I'll look at 9:30.", "", "The deploy finished."]);
  });

  it("files changed in the turn before a wake-up show under that turn, not under the reply", () => {
    const files = entry({ kind: "files", files: [{ path: "report.md", change: "added" }] });
    const rows = displayRows(committedRows([entry({ kind: "assistant", text: "Wrote the report." }), files, wake(), reply()]));
    expect(rows.map((r) => r.kind)).toEqual(["assistant", "files", "wake", "assistant"]);
  });

  it("the user's own message stays, even when it reads like a wake-up", () => {
    const rows = committedRows([entry({ kind: "user", text: "[Wake-up] remind me about wake-ups" }), reply()]);
    expect(rows[0]).toMatchObject({ kind: "user", text: "[Wake-up] remind me about wake-ups" });
  });

  it("a wake-up waiting in the inbox shows no row, the user's queued message does", () => {
    const snapshot = {
      inbox: [
        { requestId: "wake:1", text: "[Wake-up] check the deploy", source: "wake", mode: "followUp", at: 1 },
        { requestId: "r2", text: "and the wake-up?", mode: "followUp", at: 2 },
      ],
      pending: [],
    } as unknown as ConversationSnapshot;
    expect(tailRows(snapshot, false)).toEqual([expect.objectContaining({ kind: "user", text: "and the wake-up?", state: "queued" })]);
  });
});

describe("web search rows", () => {
  const searches = [{ action: "search", queries: ["retry backoff"], sourceCount: 4 }];
  const citations = [{ url: "https://example.com/a", title: "A" }];
  const tool = () => entry({ kind: "tool", toolCallId: "call_9", name: "bash", text: "ok" });

  it("an answer keeps what it searched and what it cites", () => {
    const rows = displayRows(committedRows([entry({ kind: "assistant", text: "Use backoff.", searches, citations })]), true);
    expect(rows).toEqual([expect.objectContaining({ kind: "assistant", text: "Use backoff.", searches, citations })]);
  });

  it("an answer that only searched before calling a tool shows its searches; with tool steps hidden, it's left out", () => {
    const items = [entry({ kind: "assistant", text: "", searches, tools: [{ id: "call_9", name: "bash", summary: "" }] }), tool()];
    expect(displayRows(committedRows(items), true).map((r) => r.kind)).toEqual(["assistant", "toolgroup"]);
    expect(displayRows(committedRows(items), false)).toEqual([]);
  });

  it("with tool steps hidden, the searches go and the citations stay, the same row each time", () => {
    const committed = committedRows([entry({ kind: "assistant", text: "Use backoff.", searches, citations })]);
    const [row] = displayRows(committed, false);
    expect(row).toMatchObject({ kind: "assistant", searches: [], citations });
    expect(displayRows(committed, false)[0]).toBe(row);
  });

  it("an answer from before web search has none of either", () => {
    const [row] = committedRows([entry({ kind: "assistant", text: "Old." })]);
    expect(row).toMatchObject({ searches: [], citations: [] });
  });
});

describe("agent receipts", () => {
  const START = "collar__task_start";
  const agent = { harness: "Codex", cwd: "/home/me/app", model: "gpt-6" };
  const started = (id: string, spawned = true, isError = false) =>
    entry({
      kind: "tool",
      toolCallId: `call_${id}`,
      name: START,
      text: isError ? "There's no folder /nope." : `{"started":{"id":"${id}","state":"queued"…`,
      ...(isError ? { isError: true } : spawned ? { agent } : {}),
    });

  it("shows a fixed receipt where the bot started a new agent, and none where it carried a session on", () => {
    const first = started("task_a");
    const rows = displayRows(committedRows([said(), first, started("task_b", false)]), true);
    expect(rows.map((r) => r.kind)).toEqual(["assistant", "agent", "toolgroup"]);
    expect(rows[1]).toMatchObject({ kind: "agent", agent });
    expect(displayRows(committedRows([said(), first, started("task_b", false)]), true)[1]).toBe(rows[1]);
  });

  it("a refused start stays a tool step, and the task's messages to the bot show nothing", () => {
    const told = entry({ kind: "user", text: "[Task task_a completed] Fix", source: "task", requestId: "task:task_a:completed" });
    const rows = displayRows(committedRows([said(), started("task_b", true, true), told]), true);
    expect(rows.map((r) => r.kind)).toEqual(["assistant", "toolgroup"]);
  });
});

describe("agents' questions", () => {
  const waiting = (id: string, inputs: number, bot = BOT): WaitingTask => ({
    id,
    bot,
    title: `Task ${id}`,
    inputs: Array.from({ length: inputs }, (_, i) => ({ id: i, title: "Which database?", questions: [] })),
  });

  it("get their own card at the end, for this bot only, the same row while nothing changes", () => {
    const tasks = [waiting("t1", 1), waiting("t3", 1, BOT + 1)];
    const rows = taskQuestionRows(tasks, BOT);
    expect(rows).toMatchObject([{ kind: "taskQuestion", key: "question-t1", task: { id: "t1" } }]);
    expect(taskQuestionRows(tasks, BOT)[0]).toBe(rows[0]);
  });

  it("come after the bot's file changes, not above them", () => {
    const files = entry({ kind: "files", files: [{ path: "a.ts", change: "added" }] });
    const committed = committedRows([said(), files]);
    const rows = displayRows(committed.concat(taskQuestionRows([waiting("t1", 1)], BOT)), false);
    expect(rows.map((r) => r.kind)).toEqual(["assistant", "files", "taskQuestion"]);
  });
});

describe("citation markers OpenAI left raw", () => {
  const RELEASES = "https://github.com/earendil-works/pi/releases";
  const MODELS = "https://raw.githubusercontent.com/earendil-works/pi/main/packages/ai/src/providers/openai-codex.models.ts";
  const DATA = "https://raw.githubusercontent.com/earendil-works/pi/main/packages/ai/src/providers/data/openai-codex.json";
  const asked = () => entry({ kind: "user", text: "Also check if pi added sol 6.2 support" });
  const researched = (...steps: Record<string, unknown>[]) =>
    entry({
      kind: "assistant",
      text: "",
      tools: [{ id: "call_1", name: "edit", summary: "path: MEMORY.md" }],
      searches: [{ action: "search", queries: ['github badlogic pi-mono "gpt-6.2"'], sourceCount: 16 }, ...steps],
    });
  const opened = (url: string, failed = false) => ({ action: "open_page", url, ...(failed ? { failed: true } : {}) });
  // The answer as stored: the search ran in an earlier response, so OpenAI sent the marker without a url_citation.
  const answer = (marker = "citeturn949148view0", more: Record<string, unknown> = {}) =>
    entry({
      kind: "assistant",
      text: `**Yes—pi has added upstream \`gpt-6.2-sol\` support.** No shim needed once that release lands. ${marker}\n\nI haven’t changed Top’s dependency.`,
      ...more,
    });
  type Assistant = Extract<ReturnType<typeof committedRows>[number], { kind: "assistant" }>;
  const last = (items: TranscriptItem[]) => committedRows(items).at(-1) as Assistant;
  const raw = /[-]/;

  it("drops the marker and lists the pages the bot read that turn apart from its sources, naming none as the one cited", () => {
    const row = last([
      asked(),
      researched(opened(RELEASES), opened(MODELS), opened(DATA)),
      entry({ kind: "tool", toolCallId: "call_1", name: "edit", text: "ok" }),
      answer(),
    ]);
    expect(row.text).not.toMatch(raw);
    expect(row.text).toContain("once that release lands.\n\nI haven’t");
    expect(row.text).not.toContain("](");
    expect(row.citations).toEqual([]);
    expect(row.pagesRead).toEqual([
      { url: RELEASES, title: "releases" },
      { url: MODELS, title: "openai-codex.models.ts" },
      { url: DATA, title: "openai-codex.json" },
    ]);
  });

  it("doesn't link a marker even when the bot read only one page, and leaves out pages that failed to open", () => {
    const row = last([asked(), researched(opened(MODELS, true), opened(RELEASES)), answer()]);
    expect(row.text).not.toContain(RELEASES);
    expect(row.pagesRead).toEqual([{ url: RELEASES, title: "releases" }]);
  });

  it("lists nothing read before the person's last message, or while the turn isn't all loaded", () => {
    expect(last([researched(opened(RELEASES)), asked(), answer()])).toMatchObject({ text: expect.not.stringMatching(raw) });
    expect(last([researched(opened(RELEASES)), asked(), answer()])).not.toHaveProperty("pagesRead");
    const items = [asked(), researched(opened(RELEASES)), answer()];
    const partial = last([{ kind: "earlier" } as TranscriptItem, items[2]!]);
    expect(partial.text).not.toMatch(raw);
    expect(partial).not.toHaveProperty("pagesRead");
    expect(last(items).pagesRead).toEqual([{ url: RELEASES, title: "releases" }]);
  });

  it("keeps the citations OpenAI sent as sources, without listing them again as pages read", () => {
    const row = last([
      asked(),
      researched(opened(RELEASES), opened(MODELS)),
      answer(undefined, { citations: [{ url: `${RELEASES}?utm_source=openai`, title: "Releases · earendil-works/pi" }] }),
    ]);
    expect(row.citations).toEqual([{ url: `${RELEASES}?utm_source=openai`, title: "Releases · earendil-works/pi" }]);
    expect(row.pagesRead).toEqual([{ url: MODELS, title: "openai-codex.models.ts" }]);
  });

  it("knows a cited page that OpenAI tagged is the same page it opened, whatever else is in its query", () => {
    const search = "https://example.com/search?q=release%20notes";
    const row = last([
      asked(),
      researched(opened(search)),
      answer(undefined, { citations: [{ url: "https://example.com/search?q=release%20notes&utm_source=openai", title: "Release notes" }] }),
    ]);
    expect(row).not.toHaveProperty("pagesRead");
  });

  it("still shows an answer that was only a marker, with the sources OpenAI sent for it", () => {
    const sources = [{ url: `${RELEASES}?utm_source=openai`, title: "Releases · earendil-works/pi" }];
    const marked = entry({ kind: "assistant", text: "\ue200cite\ue202turn1view0\ue201", citations: sources });
    const rows = displayRows(committedRows([asked(), marked]), false);
    expect(rows.at(-1)).toMatchObject({ kind: "assistant", text: "", citations: sources });
  });

  it("still shows an answer that was only a marker, with the pages read", () => {
    const rows = displayRows(committedRows([asked(), researched(opened(RELEASES)), entry({ kind: "assistant", text: "citeturn1view0" })]), false);
    expect(rows.at(-1)).toMatchObject({ kind: "assistant", text: "", pagesRead: [{ url: RELEASES, title: "releases" }] });
  });
});
