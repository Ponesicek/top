import type { Entry } from "@top/protocol";
import * as Effect from "effect/Effect";
import { expect, test } from "vitest";
import type { Connection } from "../src/connection.ts";
import { type ClientRuntime, ConversationSync } from "../src/conversation.ts";

const BOT = 1;
const user = (seq: number, text: string, requestId?: string): Entry =>
  ({ seq, bot: BOT, at: seq, kind: "user", text, ...(requestId ? { requestId } : {}) }) as Entry;
const reply = (seq: number): Entry => ({ seq, bot: BOT, at: seq, kind: "assistant", text: `answer ${seq}` }) as Entry;
const run: ClientRuntime = { promise: (effect) => Effect.runPromise(effect), fork: (effect) => void Effect.runFork(effect) };

/** A connection that's offline for sends and answers history requests with `page`. */
function offline(page: () => { entries: Entry[]; more: boolean }): Connection {
  return {
    status: () => "closed",
    send: () => {},
    request: () => Effect.succeed(page()),
  } as unknown as Connection;
}

test("a message sent before a reconnect that missed it shows once when the missed stretch is loaded, as the saved message", async () => {
  // History in the gap: the saved send, far more than the last 200 entries back, then 250 newer entries.
  const missed = [user(101, "deploy web", "r1"), reply(102)];
  const sync = new ConversationSync(
    BOT,
    offline(() => ({ entries: missed, more: false })),
    "client",
    run,
  );
  const sent = sync.send("deploy web");
  const newer = Array.from({ length: 250 }, (_, i) => reply(400 + i));
  sync.receiveSync({ entries: [user(100, "earlier"), ...newer], gap: { after: 100, before: 400 }, inbox: [] });
  expect(sync.getSnapshot().pending.map((p) => p.requestId)).toEqual([sent.requestId]);

  // The saved entry carries the request id of the pending send.
  missed[0] = user(101, "deploy web", sent.requestId);
  const gap = sync.getSnapshot().items.find((item) => item.kind === "gap");
  if (gap?.kind !== "gap") throw new Error("expected a gap");
  await sync.fillGap(gap.gap);

  const snapshot = sync.getSnapshot();
  expect(snapshot.pending).toEqual([]);
  const saved = snapshot.items.filter((item) => item.kind === "entry" && item.entry.kind === "user" && item.entry.requestId === sent.requestId);
  expect(saved).toHaveLength(1);
});

test("loading earlier history retires a pending send it turns out to contain, too", async () => {
  const sync = new ConversationSync(
    BOT,
    offline(() => ({ entries: [user(5, "hello", sent.requestId)], more: false })),
    "client",
    run,
  );
  const sent = sync.send("hello");
  sync.receiveSync({ entries: Array.from({ length: 250 }, (_, i) => reply(10 + i)), earlier: true, inbox: [] });
  expect(sync.getSnapshot().pending).toHaveLength(1);
  await sync.loadEarlier();
  expect(sync.getSnapshot().pending).toEqual([]);
});
