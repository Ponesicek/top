import type { BotSummary } from "@top/protocol";
import { afterEach, expect, test } from "vitest";
import { TopClient } from "../src/index.ts";

const bot = (id: number, name: string): BotSummary =>
  ({ id, name, description: "", status: "idle", since: 0, preview: "", queued: 0, lastSeq: 0 }) as BotSummary;
const ROSTER = [bot(1, "Atlas"), bot(2, "Juniper"), bot(3, "Moss")];

/** A daemon on the other end of a WebSocket, played by the test. */
class FakeSocket {
  static last: FakeSocket | undefined;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 0;
  readonly sent: Record<string, unknown>[] = [];
  constructor(_url: string) {
    FakeSocket.last = this;
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.();
    });
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
  }
  frame(frame: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  /** The daemon's answer to the last setBotOrder it got. */
  answer(ok: boolean, nth = -1) {
    const asked = this.sent.filter((f) => f.t === "setBotOrder").at(nth)!;
    this.frame(ok ? { t: "result", req: asked.req, ok: true, value: null } : { t: "result", req: asked.req, ok: false, error: "No." });
  }
}

const clients: TopClient[] = [];
afterEach(() => {
  for (const c of clients.splice(0)) c.close();
});

async function connected() {
  const client = new TopClient({ url: "ws://fake", WebSocket: FakeSocket as unknown as typeof WebSocket });
  clients.push(client);
  for (let i = 0; i < 50 && client.getSnapshot().connection !== "open"; i++) await new Promise((r) => setTimeout(r, 5));
  const socket = FakeSocket.last!;
  socket.frame({ t: "bots", bots: ROSTER });
  return { client, socket, names: () => client.getSnapshot().bots.map((b) => b.name) };
}

test("a reorder the daemon refuses is undone here", async () => {
  const { client, socket, names } = await connected();
  const done = client.setBotOrder([3, 1, 2]);
  expect(names()).toEqual(["Moss", "Atlas", "Juniper"]);
  socket.answer(false);
  await expect(done).rejects.toThrow();
  expect(names()).toEqual(["Atlas", "Juniper", "Moss"]);
});

test("a refused reorder doesn't undo a newer list from the daemon", async () => {
  const { client, socket, names } = await connected();
  const done = client.setBotOrder([3, 1, 2]);
  socket.frame({ t: "bots", bots: [ROSTER[1], ROSTER[2], ROSTER[0]] });
  socket.answer(false);
  await expect(done).rejects.toThrow();
  expect(names()).toEqual(["Juniper", "Moss", "Atlas"]);
});

test("a refused reorder doesn't undo a newer reorder made here", async () => {
  const { client, socket, names } = await connected();
  const first = client.setBotOrder([3, 1, 2]);
  const second = client.setBotOrder([2, 3, 1]);
  socket.answer(false, 0);
  await expect(first).rejects.toThrow();
  expect(names()).toEqual(["Juniper", "Moss", "Atlas"]);
  socket.answer(true, 1);
  await second;
  expect(names()).toEqual(["Juniper", "Moss", "Atlas"]);
});

test("two reorders both refused, the second while the first is still out, end in the daemon's order", async () => {
  for (const refusedFirst of [1, 0]) {
    const { client, socket, names } = await connected();
    const reorders = [client.setBotOrder([3, 1, 2]), client.setBotOrder([2, 3, 1])];
    socket.answer(false, refusedFirst);
    await expect(reorders[refusedFirst]).rejects.toThrow();
    socket.answer(false, 1 - refusedFirst);
    await expect(reorders[1 - refusedFirst]).rejects.toThrow();
    expect(names()).toEqual(["Atlas", "Juniper", "Moss"]);
  }
});
