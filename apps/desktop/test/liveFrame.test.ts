import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveFrames } from "../src/liveFrame.ts";

const bytes = (text: string) => new TextEncoder().encode(text);

function harness(initial: string, swapAfterMs = 60_000) {
  let content = initial;
  let fail = false;
  const live = new LiveFrames(
    1,
    async () => {
      if (fail) throw new Error("offline");
      return bytes(content);
    },
    swapAfterMs,
  );
  let renders = 0;
  live.subscribe(() => renders++);
  return {
    live,
    write: (text: string) => {
      content = text;
    },
    failReads: () => {
      fail = true;
    },
    renders: () => renders,
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const shown = (live: LiveFrames) => live.frames().map((f) => (f.shown ? "shown" : "loading"));

afterEach(() => {
  vi.useRealTimers();
});

describe("LiveFrames", () => {
  it("gives up on a read that doesn't answer, stops it, and loads the save behind the page shown", async () => {
    let calls = 0;
    let first: AbortSignal | undefined;
    const live = new LiveFrames(
      1,
      (signal) => {
        if (++calls > 1) return Promise.resolve(bytes("<h1>new</h1>"));
        first = signal;
        return new Promise<Uint8Array>((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
      },
      60_000,
      20,
    );
    live.show(2);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(first?.aborted).toBe(true);
    expect(shown(live)).toEqual(["shown", "loading"]);
  });

  it("keeps the page it shows when the file is saved again with the same content", async () => {
    const { live, renders } = harness("<h1>Report</h1>");
    const before = live.frames();
    await settle();
    live.show(2);
    await settle();
    live.show(3);
    await settle();
    expect(live.frames()).toBe(before);
    expect(renders()).toBe(0);
  });

  it("loads a changed page behind the one shown, and swaps only once it has loaded", async () => {
    const { live, write } = harness("<h1>Report</h1>");
    const [first] = live.frames();
    await settle();
    write("<h1>Report, updated</h1>");
    live.show(2);
    await settle();
    const [old, next] = live.frames();
    expect(old).toBe(first);
    expect(shown(live)).toEqual(["shown", "loading"]);
    live.loaded(old!.key);
    expect(shown(live)).toEqual(["shown", "loading"]);
    live.loaded(next!.key);
    expect(live.frames()).toEqual([{ key: next!.key, shown: true }]);
  });

  it("compares with the page that will show, not with a save it skipped", async () => {
    const { live, write } = harness("a");
    write("b");
    live.show(2);
    write("b");
    live.show(3);
    await settle();
    expect(shown(live)).toEqual(["shown", "loading"]);
    const pending = live.frames()[1];
    live.show(4);
    await settle();
    expect(live.frames()[1]).toBe(pending);
  });

  it("replaces a page still loading with a newer change", async () => {
    const { live, write } = harness("a");
    await settle();
    write("b");
    live.show(2);
    await settle();
    const stale = live.frames()[1]!;
    write("c");
    live.show(3);
    await settle();
    const fresh = live.frames()[1]!;
    expect(shown(live)).toEqual(["shown", "loading"]);
    expect(fresh.key).not.toBe(stale.key);
    live.loaded(stale.key);
    expect(shown(live)).toEqual(["shown", "loading"]);
    live.loaded(fresh.key);
    expect(live.frames()).toEqual([{ key: fresh.key, shown: true }]);
  });

  it("gives every frame its own key, even when a file's time goes back to an earlier one", async () => {
    const { live, write } = harness("a");
    await settle();
    write("b");
    live.show(2);
    await settle();
    write("c");
    live.show(1);
    await settle();
    const keys = live.frames().map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("shows a changed page anyway when it takes too long to finish loading", async () => {
    vi.useFakeTimers();
    const { live, write } = harness("a", 3_000);
    await vi.advanceTimersByTimeAsync(0);
    write("b");
    live.show(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(shown(live)).toEqual(["shown", "loading"]);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(shown(live)).toEqual(["shown", "loading"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(shown(live)).toEqual(["shown"]);
  });

  it("reloads when it can't tell whether the content changed", async () => {
    const { live, failReads } = harness("a");
    await settle();
    failReads();
    live.show(2);
    await settle();
    expect(shown(live)).toEqual(["shown", "loading"]);
  });
});
