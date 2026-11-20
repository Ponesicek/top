import { expect, test } from "vitest";
import { move, nearest, withRestOrder } from "../src/order.ts";

test("moving an item keeps everything else in order", () => {
  expect(move([1, 2, 3, 4], 0, 2)).toEqual([2, 3, 1, 4]);
  expect(move([1, 2, 3, 4], 3, 0)).toEqual([4, 1, 2, 3]);
  expect(move([1, 2, 3, 4], 1, 1)).toEqual([1, 2, 3, 4]);
  expect(move([1, 2, 3], 2, 9)).toEqual([1, 2, 3]);
  expect(move([1, 2, 3], -1, 0)).toEqual([1, 2, 3]);
});

test("reordering the unpinned bots leaves pinned ones where the daemon has them, so other devices see only that change", () => {
  // Daemon order 1..5; this device pins 2 and 4, so it lists 1, 3, 5 below them and moves 5 to the front.
  expect(withRestOrder([1, 2, 3, 4, 5], [2, 4], [5, 1, 3])).toEqual([5, 2, 1, 4, 3]);
  expect(withRestOrder([1, 2, 3], [], [3, 2, 1])).toEqual([3, 2, 1]);
  // A bot made or deleted meanwhile: an unknown id is skipped, a missing one keeps its place.
  expect(withRestOrder([1, 2, 3, 6], [], [3, 9, 1])).toEqual([3, 2, 1, 6]);
});

test("a dragged bot goes to the slot whose centre is closest, in a list or a grid of pinned tiles", () => {
  const list = [0, 1, 2].map((i) => ({ x: 100, y: 30 + i * 60 }));
  expect(nearest({ x: 100, y: 10 }, list)).toBe(0);
  expect(nearest({ x: 140, y: 95 }, list)).toBe(1);
  expect(nearest({ x: 100, y: 999 }, list)).toBe(2);
  const grid = [0, 1, 2, 3].map((i) => ({ x: 40 + (i % 3) * 80, y: 40 + Math.floor(i / 3) * 90 }));
  expect(nearest({ x: 200, y: 50 }, grid)).toBe(2);
  expect(nearest({ x: 50, y: 140 }, grid)).toBe(3);
  expect(nearest({ x: 0, y: 0 }, [])).toBe(-1);
});
