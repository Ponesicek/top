/**
 * Quotes: passages of a bot's answers you reply to, each with an optional comment. In the composer a
 * quote is a chip that sits wherever you put it in your text; in the message it becomes a citation
 * link, `[Quote](top-quote://v1/<seq>?text=…&comment=…)`, which carries the passage, your comment and
 * the answer it came from (that entry's `seq`). The bot is told how to read these (the daemon's
 * `quotes` prompt section); the transcript shows them as quotes that jump back to the answer.
 */

/** A quote waiting in the composer. `id` names its chip; `seq` is the answer's entry. */
export type Quote = { id: number; seq: number; text: string; comment: string };

/** A quote as a sent message carries it. */
export type Citation = { seq: number; text: string; comment: string };

// ── quotes waiting in the composer ──────────────────────────────────────────

const pending = new Map<string, Map<number, Quote>>();
const added = new Map<string, (quote: Quote) => void>();
let nextId = 1;

/** A new quote for `bot`'s composer, which puts its chip where the caret was. */
export function addQuote(bot: string, seq: number, text: string, comment: string) {
  const quote: Quote = { id: nextId++, seq, text, comment: comment.trim() };
  quotesOf(bot).set(quote.id, quote);
  added.get(bot)?.(quote);
}

/** The composer listens for quotes added from the transcript. */
export function onQuoteAdded(bot: string, listener: (quote: Quote) => void): () => void {
  added.set(bot, listener);
  return () => {
    if (added.get(bot) === listener) added.delete(bot);
  };
}

export function quotesOf(bot: string): Map<number, Quote> {
  let quotes = pending.get(bot);
  if (!quotes) {
    quotes = new Map();
    pending.set(bot, quotes);
  }
  return quotes;
}

/** After a send: the chips are gone, and so is what they held. */
export function clearQuotes(bot: string) {
  pending.delete(bot);
}

// ── the citation link ───────────────────────────────────────────────────────

const SCHEME = "top-quote://v1/";
const LINK = /\[[^\]\n]*\]\(top-quote:\/\/v1\/(\d+)\?([^)\s]*)\)/g;

export function citationLink(quote: Citation): string {
  const params = new URLSearchParams({ text: quote.text });
  if (quote.comment) params.set("comment", quote.comment);
  return `[Quote](${SCHEME}${quote.seq}?${params})`;
}

export type MessagePart = { kind: "text"; text: string } | ({ kind: "quote" } & Citation);

/** A sent message's text and quotes in order, or undefined when it quotes nothing (the common case). */
export function messageParts(message: string): MessagePart[] | undefined {
  if (!message.includes(SCHEME)) return undefined;
  const parts: MessagePart[] = [];
  let at = 0;
  for (const match of message.matchAll(LINK)) {
    if (match.index > at) parts.push({ kind: "text", text: message.slice(at, match.index) });
    const params = new URLSearchParams(match[2]);
    parts.push({ kind: "quote", seq: Number(match[1]), text: params.get("text") ?? "", comment: params.get("comment") ?? "" });
    at = match.index + match[0].length;
  }
  if (at < message.length) parts.push({ kind: "text", text: message.slice(at) });
  return parts.some((p) => p.kind === "quote") ? parts : undefined;
}

// ── reading and finding passages in rendered answers ────────────────────────

/** Furniture inside rendered answers that isn't part of what the bot said. */
const NOT_TEXT = ".code-head, .stamp-space, time, button, [aria-hidden='true']";

/**
 * The text of `range` as it reads on screen (paragraphs and lines kept), without code-block headers,
 * copy buttons or times. It's measured in a hidden copy, because only rendered text has line breaks.
 */
export function rangeText(range: Range): string {
  const holder = document.createElement("div");
  holder.className = "md";
  holder.style.cssText = "position:fixed;left:-10000px;top:0;width:600px;white-space:normal;pointer-events:none;opacity:0";
  holder.append(range.cloneContents());
  for (const el of holder.querySelectorAll(NOT_TEXT)) el.remove();
  document.body.append(holder);
  const text = holder.innerText;
  holder.remove();
  return text
    .replaceAll(String.fromCharCode(0xa0), " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Where `passage` is in a rendered answer, as a range, or null. Whitespace doesn't count: the passage
 * was read with line breaks the DOM's text doesn't have.
 */
export function findPassage(answer: Element, passage: string): Range | null {
  const target = passage.replace(/\s+/g, "");
  if (!target) return null;
  // Every visible non-space character of the answer, and where it is.
  let chars = "";
  const at: { node: Text; offset: number }[] = [];
  const walker = document.createTreeWalker(answer, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (node.parentElement?.closest(NOT_TEXT) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const text = node.data;
    for (let i = 0; i < text.length; i++) {
      if (/\s/.test(text[i]!)) continue;
      chars += text[i];
      at.push({ node, offset: i });
    }
  }
  const start = chars.indexOf(target);
  if (start < 0) return null;
  const first = at[start]!;
  const last = at[start + target.length - 1]!;
  const range = document.createRange();
  range.setStart(first.node, first.offset);
  range.setEnd(last.node, last.offset + 1);
  return range;
}

// ── jumping from a sent quote to its answer ─────────────────────────────────

const jumpers = new Map<string, (citation: Citation) => void>();

/** The transcript of `bot` scrolls to a quoted passage and lights it up. */
export function onJump(bot: string, listener: (citation: Citation) => void): () => void {
  jumpers.set(bot, listener);
  return () => {
    if (jumpers.get(bot) === listener) jumpers.delete(bot);
  };
}

export function jumpTo(bot: string, citation: Citation) {
  jumpers.get(bot)?.(citation);
}
