import { expect, test, vi } from "vitest";
import { onPinToEnd, pinToEnd, stillPinned } from "../src/scrollPin.ts";

const at = (top: number) => ({ top, height: 10_000, client: 600 });

test("near the end is always pinned", () => {
  expect(stillPinned(false, at(9_400), 9_000, true)).toBe(true);
  expect(stillPinned(false, at(9_360), 9_400, false)).toBe(true);
});

test("a scroll the layout caused never un-pins, even when it moves the view up and away from the end", () => {
  // A pending row swapped for its committed one shrinks the content; the browser clamps scrollTop.
  expect(stillPinned(true, at(9_000), 9_400, false)).toBe(true);
  // Three quick sends: the second scroll lands far from the end before the next pin.
  expect(stillPinned(true, at(8_878), 9_400, false)).toBe(true);
});

test("the person scrolling up un-pins it; scrolling down or staying put doesn't", () => {
  expect(stillPinned(true, at(9_000), 9_400, true)).toBe(false);
  expect(stillPinned(true, at(9_000), 8_900, true)).toBe(true);
  expect(stillPinned(true, at(9_000), 9_000, true)).toBe(true);
});

test("once un-pinned, only reaching the end pins it again", () => {
  expect(stillPinned(false, at(5_000), 4_000, false)).toBe(false);
  expect(stillPinned(false, at(5_000), 6_000, true)).toBe(false);
});

test("a send pins only its own bot's conversation, and a closed one isn't called", () => {
  const atlas = vi.fn();
  const moss = vi.fn();
  const offAtlas = onPinToEnd(1, atlas);
  const offMoss = onPinToEnd("2", moss);
  pinToEnd(1);
  expect(atlas).toHaveBeenCalledTimes(1);
  expect(moss).not.toHaveBeenCalled();
  offAtlas();
  pinToEnd("1");
  expect(atlas).toHaveBeenCalledTimes(1);
  offMoss();
});
