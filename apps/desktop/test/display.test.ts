import { expect, test } from "vitest";
import { forgetRemovedSettings } from "../src/display.ts";

const storage = (entries: Record<string, string>) => {
  const map = new Map(Object.entries(entries));
  return { map, removeItem: (key: string) => void map.delete(key) };
};

test("a stored conversation style or avatar style from before is dropped, and the other settings stay", () => {
  for (const [style, avatars] of [
    ["team", "mono"],
    ["default", "color"],
    ["chat", "mono"],
    ["something-else", ""],
  ]) {
    const saved = storage({ "top.chatStyle": style!, "top.avatars": avatars!, "top.showTools": "1", "top.scale": "1.1", "top.selected": "3" });
    forgetRemovedSettings(saved);
    expect(Object.fromEntries(saved.map)).toEqual({ "top.showTools": "1", "top.scale": "1.1", "top.selected": "3" });
  }
});

test("storage that can't be reached or throws doesn't stop the app from starting", () => {
  expect(() => forgetRemovedSettings(undefined)).not.toThrow();
  expect(() =>
    forgetRemovedSettings({
      removeItem: () => {
        throw new Error("denied");
      },
    }),
  ).not.toThrow();
});
