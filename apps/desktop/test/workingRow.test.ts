import type { BotSummary } from "@top/client";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { DisplayRow } from "../src/rows.ts";

const state = vi.hoisted(() => ({ bot: undefined as BotSummary | undefined }));
vi.mock("../src/top.ts", () => ({ top: {}, useBot: () => state.bot, useClient: () => false }));
vi.mock("../src/components/transcript/MessageAttachments.tsx", () => ({ MessageAttachments: () => null }));
vi.mock("../src/components/Sidebar.tsx", () => ({ statusLabel: (bot: BotSummary) => (bot.status === "retrying" ? "Retrying" : "Working") }));

const { renderDefaultRow } = await import("../src/components/transcript/DefaultRows.tsx");
const { renderTeamRow } = await import("../src/components/transcript/TeamRows.tsx");
const { renderChatRow } = await import("../src/components/transcript/ChatRows.tsx");
const { IdentityProvider } = await import("../src/components/transcript/parts.tsx");

const identity = { sync: { id: 1 }, name: "Quill", avatar: undefined } as never;
const draw = (render: typeof renderDefaultRow, rows: DisplayRow[]) =>
  renderToStaticMarkup(createElement(IdentityProvider, { value: identity }, render(rows, rows.length - 1)));
const retrying = { status: "retrying", error: "Provider overloaded (test)", since: Date.now() } as unknown as BotSummary;
const user: DisplayRow = { kind: "user", key: "u", text: "fail always", at: 1_000 } as DisplayRow;
const working: DisplayRow = { kind: "working", key: "working" };
const classes = (html: string, has: string) => [...html.matchAll(/<div class="([^"]*)"/g)].map((m) => m[1]!).filter((c) => c.split(" ").includes(has));
// An inline-level box shares a line with its neighbour: the retry note sat beside the status line,
// and the taller note pushed the status line below the avatar.
const inline = (c: string) => /(^| )inline-(flex|block|grid)( |$)/.test(c);

describe("a bot's working row", () => {
  it("puts the retry note on its own line under the status, in every conversation style", () => {
    state.bot = retrying;
    for (const render of [renderDefaultRow, renderTeamRow, renderChatRow]) {
      const html = draw(render, [user, working]);
      const notes = classes(html, "bg-destructive-surface");
      expect(notes).toHaveLength(1);
      expect(html).toContain("Retrying: Provider overloaded (test)");
      expect(notes.filter(inline)).toEqual([]);
    }
    const status = classes(draw(renderDefaultRow, [user, working]), "text-small");
    expect(status).toHaveLength(1);
    expect(status.filter(inline)).toEqual([]);
  });

  it("lines a failed answer's note up with the avatar when the note is all there is", () => {
    state.bot = undefined;
    const failed = {
      kind: "assistant",
      key: "a",
      seq: 2,
      text: "",
      at: 2_000,
      error: "Provider overloaded (test)",
      searches: [],
      citations: [],
    } as unknown as DisplayRow;
    const html = draw(renderDefaultRow, [user, failed]);
    const body = html.slice(html.indexOf('<div class="min-w-0 flex-1">') + '<div class="min-w-0 flex-1">'.length);
    expect(body).toMatch(/^<div class="[^"]*\bfirst:mt-0\b[^"]*">.*Failed: Provider overloaded \(test\)/);
    expect(classes(html, "bg-destructive-surface").filter(inline)).toEqual([]);
  });
});
