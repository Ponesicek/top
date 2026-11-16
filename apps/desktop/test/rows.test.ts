/**
 * A bot's permission request shows as one row where it asked, and settles to what came of it: the
 * call's result, or (after it moved to the background) its job's message. Never a tool step as well.
 */
import { ASK_PERMISSION, type Entry, type TranscriptItem } from "@top/client";
import { describe, expect, it } from "vitest";
import { committedRows, displayRows } from "../src/rows.ts";

const BOT = 3;
let seq = 0;
const entry = (e: Record<string, unknown>): TranscriptItem => ({ kind: "entry", entry: { seq: ++seq, bot: BOT, at: 1_000 + seq, ...e } as Entry });
const ask = (id: string) =>
  entry({
    kind: "assistant",
    text: "I'll check with you first.",
    tools: [{ id, name: ASK_PERMISSION, summary: "action: deploy web", permission: { action: "deploy web", reason: "It's Friday." } }],
  });
const result = (id: string, extra: Record<string, unknown> = {}) => entry({ kind: "tool", toolCallId: id, name: ASK_PERMISSION, text: "…", ...extra });
const permissionRows = (items: TranscriptItem[]) => displayRows(committedRows(items)).filter((r) => r.kind === "permission");

describe("permission rows", () => {
  it("waits with no result, and shows no tool step for the call", () => {
    const items = [ask("c1")];
    const rows = displayRows(committedRows(items));
    expect(rows.map((r) => r.kind)).toEqual(["assistant", "permission"]);
    expect(rows[1]).toMatchObject({ toolCallId: "c1", bot: BOT, ask: { action: "deploy web", reason: "It's Friday." } });
    expect(rows[1]).not.toHaveProperty("answer");
  });

  it("settles from the call's result: allowed, denied, stopped, or cut off by a restart", () => {
    expect(permissionRows([ask("a"), result("a", { permission: "allowed" })])[0]).toMatchObject({ answer: "allowed" });
    expect(permissionRows([ask("d"), result("d", { permission: "denied" })])[0]).toMatchObject({ answer: "denied" });
    expect(permissionRows([ask("s"), result("s", { isError: true, text: "Stopped" })])[0]).toMatchObject({ answer: "stopped" });
    expect(permissionRows([ask("r"), result("r", { outcome: "not_run" })])[0]).toMatchObject({ answer: "restarted" });
    // The result shows only in the row: no tool group beside it.
    expect(displayRows(committedRows([ask("x"), result("x", { permission: "allowed" })])).map((r) => r.kind)).toEqual(["assistant", "permission"]);
  });

  it("after it moves to the background, settles from its job's message, which stays hidden", () => {
    const moved = [ask("b"), result("b", { job: 7, text: "Still running after 30 s, so it moved to the background as job 7" })];
    const waiting = permissionRows(moved);
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({ job: 7 });
    expect(waiting[0]).not.toHaveProperty("answer");

    const answered = [
      ...moved,
      entry({ kind: "user", text: "[Background job 7 finished] …", source: "job", requestId: "job:7:1", job: 7, permission: "allowed" }),
    ];
    const rows = displayRows(committedRows(answered));
    expect(rows.map((r) => r.kind)).toEqual(["assistant", "permission"]);
    expect(rows[1]).toMatchObject({ answer: "allowed", job: 7 });

    const cutOff = [...moved, entry({ kind: "user", text: "[Background job 7 was cut off] …", source: "job", requestId: "job:7:2", job: 7 })];
    expect(permissionRows(cutOff)[0]).toMatchObject({ answer: "restarted" });
  });

  it("a call refused before anyone was asked (bad arguments) is an ordinary failed tool step, not a request", () => {
    const rows = displayRows(committedRows([ask("v"), result("v", { isError: true, text: "Say what you want to do in `action`." })]));
    expect(rows.map((r) => r.kind)).toEqual(["assistant", "toolgroup"]);
  });

  it("keeps the same row object while nothing about it changes, so it doesn't re-render", () => {
    const items = [ask("k")];
    const first = permissionRows(items)[0];
    expect(permissionRows([...items])[0]).toBe(first);
    expect(permissionRows([...items, result("k", { permission: "denied" })])[0]).not.toBe(first);
  });
});
