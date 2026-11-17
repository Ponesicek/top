/**
 * A bot's permission request shows as one card where it asked (its call's result, which names the
 * request), and settles from the `permission` entry naming that request. Never a tool step as well,
 * and the entry and the bot's message about the answer show no row of their own.
 */
import type { Entry, TranscriptItem } from "@top/client";
import { describe, expect, it } from "vitest";
import { committedRows, displayRows } from "../src/rows.ts";

const BOT = 3;
const ASK = "collar__ask_permission";
let seq = 0;
const entry = (e: Record<string, unknown>): TranscriptItem => ({ kind: "entry", entry: { seq: ++seq, bot: BOT, at: 1_000 + seq, ...e } as Entry });
const said = () => entry({ kind: "assistant", text: "I'll check with you first.", tools: [{ id: "call_1", name: ASK, summary: "action: deploy web" }] });
/** The call's result: it asked, as request `id`. Providers may reuse the call's id in a later turn. */
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
