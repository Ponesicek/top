/**
 * The bot roster and the sidebar summaries.
 *
 * The roster is a Session document, committed like everything else. Summaries come from one small
 * view observer per bot (window of 1 entry plus its `pi.live` and `pi.inbox` documents), so the
 * sidebar never needs a full transcript.
 */
import type { Context } from "@earendil-works/chord";
import {
  defineDoc,
  type ConversationView,
  type Harness,
  type InboxState,
  type LiveState,
} from "@earendil-works/pi-durable";
import type { BotStatus, BotSummary } from "@top/protocol";
import { BOT_NAMES, FAKE_MODEL, FAKE_PROVIDER } from "./fake-bots.ts";

export type Bot = { readonly id: number; readonly name: string };

const Roster = defineDoc<{ bots: Bot[] }>({
  kind: "top.roster",
  version: 1,
  scope: "session",
  initial: () => ({ bots: [] }),
  checkpointWhen: () => true,
});

export async function ensureBots(harness: Harness, context: Context): Promise<Bot[]> {
  const roster = await harness.snapshot(Roster, context);
  if (roster && roster.bots.length > 0) return [...roster.bots];
  const bots: Bot[] = [];
  for (const name of BOT_NAMES) {
    const conversation = await harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: {
          model: { provider: FAKE_PROVIDER, modelId: FAKE_MODEL },
          instructions: `You are ${name}, one of the user's bots.`,
        },
      },
      context,
    );
    bots.push({ id: conversation.id as unknown as number, name });
  }
  await harness.commit(async (tx) => {
    (await tx.doc(Roster)).bots = bots;
  }, context);
  return bots;
}

type MessageLike = { role?: string; content?: unknown };

function textOf(message: MessageLike | undefined): string {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .map((part: { type?: string; text?: string }) => (part.type === "text" ? (part.text ?? "") : ""))
    .join("");
}

function lastLine(text: string): string {
  const lines = text.trimEnd().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.replace(/[`*#|>-]/g, "").trim();
    if (line) return line.slice(0, 120);
  }
  return "";
}

function summarize(bot: Bot, view: ConversationView, updatedAt: number): BotSummary {
  const live = view.docs["pi.live"] as LiveState | undefined;
  const inbox = view.docs["pi.inbox"] as InboxState | undefined;
  let status: BotStatus = "idle";
  let preview = "";
  if (live?.run) {
    const streamed = textOf(live.generation?.message as MessageLike | undefined);
    if (live.tools?.length) status = "tool";
    else status = streamed ? "streaming" : "thinking";
    preview = lastLine(streamed);
  } else if (live?.runFailure && live.runFailure.reason !== "aborted") {
    status = "failed";
  }
  if (!preview) {
    const entry = view.entries.at(-1);
    const message = entry?.model?.at(-1) as MessageLike | undefined;
    preview = lastLine(textOf(message));
  }
  return { id: bot.id, name: bot.name, status, preview, queued: inbox?.items.length ?? 0, updatedAt };
}

/** Keeps every bot's summary current and tells listeners, at most every `intervalMs`. */
export class BotDirectory {
  readonly #summaries = new Map<number, BotSummary>();
  readonly #listeners = new Set<(bots: readonly BotSummary[]) => void>();
  readonly #detach: (() => void)[] = [];
  readonly #intervalMs: number;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #list: readonly BotSummary[] = [];

  private constructor(intervalMs: number) {
    this.#intervalMs = intervalMs;
  }

  static async open(harness: Harness, bots: readonly Bot[], context: Context, intervalMs = 100) {
    const directory = new BotDirectory(intervalMs);
    for (const bot of bots) {
      const conversation = await harness.conversation(bot.id as never, context);
      if (!conversation) throw new Error(`Bot ${bot.name} has no conversation ${bot.id}`);
      const observation = await harness.observeConversation(
        conversation.id,
        {
          advance: (call) => {
            if (call.kind !== "value") return;
            directory.#summaries.set(bot.id, summarize(bot, call.value, Date.now()));
            directory.#schedule();
          },
          end: () => {},
        },
        context,
        { min: 1, max: 2 },
      );
      directory.#detach.push(() => observation.detach());
      if (!directory.#summaries.has(bot.id)) directory.#summaries.set(bot.id, summarize(bot, observation.value, Date.now()));
    }
    directory.#list = bots.map((bot) => directory.#summaries.get(bot.id)!);
    return directory;
  }

  get list(): readonly BotSummary[] {
    return this.#list;
  }

  subscribe(listener: (bots: readonly BotSummary[]) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #schedule() {
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#list = [...this.#summaries.values()];
      for (const listener of this.#listeners) listener(this.#list);
    }, this.#intervalMs);
  }

  close() {
    clearTimeout(this.#timer);
    for (const detach of this.#detach) detach();
  }
}
