export type Quote = { id: number; seq: number; text: string; comment: string };

export type Citation = { seq: number; text: string; comment: string };

const pending = new Map<string, Map<number, Quote>>();
const added = new Map<string, (quote: Quote) => void>();
let nextId = 1;

export function addQuote(bot: string, seq: number, text: string, comment: string) {
  const quote: Quote = { id: nextId++, seq, text, comment: comment.trim() };
  quotesOf(bot).set(quote.id, quote);
  added.get(bot)?.(quote);
}

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

export function clearQuotes(bot: string) {
  pending.delete(bot);
}

const SCHEME = "top-quote://v1/";
const LINK = /\[[^\]\n]*\]\(top-quote:\/\/v1\/(\d+)\?([^)\s]*)\)/g;

export function citationLink(quote: Citation): string {
  const params = new URLSearchParams({ text: quote.text });
  if (quote.comment) params.set("comment", quote.comment);
  return `[Quote](${SCHEME}${quote.seq}?${params})`;
}

export type MessagePart = { kind: "text"; text: string } | ({ kind: "quote" } & Citation);

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

const NOT_TEXT = ".code-head, .stamp-space, time, button, [aria-hidden='true']";

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

export function findPassage(answer: Element, passage: string): Range | null {
  const target = passage.replace(/\s+/g, "");
  if (!target) return null;
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

const jumpers = new Map<string, (citation: Citation) => void>();

export function onJump(bot: string, listener: (citation: Citation) => void): () => void {
  jumpers.set(bot, listener);
  return () => {
    if (jumpers.get(bot) === listener) jumpers.delete(bot);
  };
}

export function jumpTo(bot: string, citation: Citation) {
  jumpers.get(bot)?.(citation);
}
