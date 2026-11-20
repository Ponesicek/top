import { expect, test } from "vitest";
import { CHAT_MIN, PANEL_MIN, panelLayout, panelMax, SIDEBAR } from "../src/panelLayout.ts";

test("the Files panel sits beside the conversation at its width while both fit", () => {
  expect(panelLayout(1600, 460)).toEqual({ overlay: false, width: 460 });
  expect(panelLayout(1280, 460)).toEqual({ overlay: false, width: 460 });
});

test("a narrower window narrows the panel first, so the conversation keeps its minimum", () => {
  for (const viewport of [1100, 1000, 900]) {
    const layout = panelLayout(viewport, 900);
    expect(layout.overlay).toBe(false);
    expect(viewport - SIDEBAR - layout.width).toBeGreaterThanOrEqual(CHAT_MIN);
    expect(layout.width).toBeGreaterThanOrEqual(PANEL_MIN);
  }
  expect(panelLayout(900, 460)).toEqual({ overlay: false, width: 280 });
});

test("when even the narrowest panel doesn't fit beside it, the panel covers the conversation instead, never wider than the window", () => {
  expect(panelLayout(899, 460)).toEqual({ overlay: true, width: 460 });
  expect(panelLayout(740, 460)).toEqual({ overlay: true, width: 460 });
  expect(panelLayout(740, 2000)).toEqual({ overlay: true, width: 740 - SIDEBAR });
  expect(panelLayout(390, 460)).toEqual({ overlay: true, width: 390 });
  expect(panelLayout(720, 300)).toEqual({ overlay: true, width: 720 });
});

test("a stored width that's too small or unreadable becomes a usable one", () => {
  expect(panelLayout(1600, 10).width).toBe(PANEL_MIN);
  expect(panelLayout(1600, Number.NaN).width).toBe(460);
  expect(panelMax(1600)).toBe(1600 - SIDEBAR - CHAT_MIN);
  expect(panelMax(800)).toBe(PANEL_MIN);
});
