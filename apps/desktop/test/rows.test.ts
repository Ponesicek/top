import type { ConversationSnapshot, Entry, TaskView, TranscriptItem } from "@top/client";
import { describe, expect, it } from "vitest";
import { committedRows, displayRows, tailRows, waitingTaskRows } from "../src/rows.ts";

const BOT = 3;
const ASK = "collar__ask_permission";
let seq = 0;
const entry = (e: Record<string, unknown>): TranscriptItem => ({ kind: "entry", entry: { seq: ++seq, bot: BOT, at: 1_000 + seq, ...e } as Entry });
const said = () => entry({ kind: "assistant", text: "I'll check with you first.", tools: [{ id: "call_1", name: ASK, summary: "action: deploy web" }] });
const asked = (id: number, toolCallId = "call_1") =>
  entry({ kind: "tool", toolCallId, name: ASK, text: "Asked the user: deploy web.", permission: { id, action: "deploy web", reason: "It's Friday." } });
const settled = (request: number, answer: string) => entry({ kind: "permission", request, answer });
const message = (request: number) =>
  entry({ kind: "user", text: "[Permission] The user allowed: deploy web.", source: "permission", requestId: `permission:${request}` });
const cards = (items: TranscriptItem[]) => displayRows(committedRows(items)).filter((r) => r.kind === "permission");

describe("permission rows", () => {
  it("waits where the bot asked, in place of the call's tool step", () => {
    const rows = displayRows(committedRows([said(), asked(1)]), true);
    expect(rows.map((r) => r.kind)).toEqual(["assistant", "permission"]);
    expect(rows[1]).toMatchObject({ bot: BOT, ask: { id: 1, action: "deploy web", reason: "It's Friday." } });
    expect(rows[1]).not.toHaveProperty("answer");
  });

  it("settles from the entry naming its request: allowed, denied or withdrawn; that entry and the bot's message show nothing", () => {
    for (const answer of ["allowed", "denied", "withdrawn"]) {
      const items = [said(), asked(5), settled(5, answer), ...(answer === "withdrawn" ? [] : [message(5)])];
      const rows = displayRows(committedRows(items), true);
      expect(rows.map((r) => r.kind)).toEqual(["assistant", "permission"]);
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
    expect(displayRows(committedRows([said(), asked(1)]), false).map((r) => r.kind)).toEqual(["assistant", "permission"]);
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

describe("task rows", () => {
  const START = "collar__task_start";
  const started = (task: string, title: string, isError = false) =>
    entry({
      kind: "tool",
      toolCallId: `call_${task}`,
      name: START,
      text: isError ? "There's no folder /nope." : `{"started":{"id":"${task}","title":${JSON.stringify(title)},"state":"queued","harness":"codex"…`,
      ...(isError ? { isError: true } : { task }),
    });

  it("shows a card where the bot started the task, with its title for when the task is no longer listed", () => {
    const rows = displayRows(committedRows([said(), started("task_a", 'Fix "login"')]), false);
    expect(rows.map((r) => r.kind)).toEqual(["assistant", "task"]);
    expect(rows[1]).toMatchObject({ bot: BOT, task: "task_a", title: 'Fix "login"' });
  });

  it("a refused start stays a tool step, and the task's messages to the bot show nothing", () => {
    const told = entry({ kind: "user", text: "[Task task_a completed] Fix", source: "task", requestId: "task:task_a:completed" });
    const rows = displayRows(committedRows([said(), started("task_b", "x", true), told]), true);
    expect(rows.map((r) => r.kind)).toEqual(["assistant", "toolgroup"]);
  });
});

describe("tasks waiting for an answer", () => {
  const view = (id: string, inputs: number, bot = BOT) =>
    ({
      id,
      bot,
      harness: "Codex",
      title: `Task ${id}`,
      state: "waiting_for_input",
      session: "s",
      cwd: "/w",
      policy: "workspace_write",
      createdAt: 1,
      inputs: Array.from({ length: inputs }, (_, i) => ({ id: i, kind: "approval", title: "Run x" })),
    }) as unknown as TaskView;

  it("get a card at the end when the card where the task started isn't loaded, or never existed", () => {
    const committed = committedRows([said()]);
    const rows = waitingTaskRows(committed, [view("t1", 1), view("t2", 0), view("t3", 1, BOT + 1)], BOT);
    expect(rows).toMatchObject([{ kind: "task", task: "t1", title: "Task t1" }]);
    expect(waitingTaskRows(committed, [view("t1", 1)], BOT)[0]).toBe(rows[0]);
  });

  it("don't get a second card when the start's card is loaded", () => {
    const started = entry({ kind: "tool", toolCallId: "c", name: "collar__task_start", text: "{}", task: "t1" });
    expect(waitingTaskRows(committedRows([said(), started]), [view("t1", 1)], BOT)).toEqual([]);
  });
});
