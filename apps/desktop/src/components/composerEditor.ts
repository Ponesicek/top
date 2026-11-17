import { citationLink, type Quote } from "../quotes.ts";

export type Segment = string | number;

const svg = (paths: string) =>
  `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const QUOTE_ICON = svg('<path d="M17 5H3"/><path d="M21 12H8"/><path d="M21 19H8"/><path d="M3 12v7"/>');
const X_ICON = svg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>');

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

export function makeChip(quote: Quote): HTMLElement {
  const chip = document.createElement("span");
  chip.className = "quote-chip";
  chip.contentEditable = "false";
  chip.draggable = false;
  chip.dataset.quote = String(quote.id);
  chip.title = quote.comment ? `${quote.text}\n\nYour comment: ${quote.comment}\n\nClick to edit the comment` : `${quote.text}\n\nClick to add a comment`;
  const icon = document.createElement("span");
  icon.className = "quote-chip-icon";
  icon.innerHTML = QUOTE_ICON;
  const text = document.createElement("span");
  text.className = "quote-chip-text";
  text.textContent = oneLine(quote.text);
  chip.append(icon, text);
  if (quote.comment) {
    const comment = document.createElement("span");
    comment.className = "quote-chip-comment";
    comment.textContent = oneLine(quote.comment);
    chip.append(comment);
  }
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "quote-chip-remove";
  remove.tabIndex = -1;
  remove.setAttribute("aria-label", "Remove quote");
  remove.innerHTML = X_ICON;
  chip.append(remove);
  return chip;
}

export function readSegments(field: HTMLElement): Segment[] {
  const out: Segment[] = [];
  const push = (text: string) => {
    if (typeof out.at(-1) === "string") out[out.length - 1] += text;
    else out.push(text);
  };
  const walk = (parent: Node) => {
    for (const node of parent.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) push((node as Text).data);
      else if (node instanceof HTMLElement) {
        if (node.dataset.quote) out.push(Number(node.dataset.quote));
        else if (node.tagName === "BR") push("\n");
        else {
          if ((node.tagName === "DIV" || node.tagName === "P") && out.length) push("\n");
          walk(node);
        }
      }
    }
  };
  walk(field);
  return out;
}

export function isEmpty(segments: readonly Segment[]): boolean {
  return segments.every((s) => typeof s === "string" && !s.trim());
}

export function toMessage(segments: readonly Segment[], quotes: ReadonlyMap<number, Quote>): string {
  return segments
    .map((s) => {
      if (typeof s === "string") return s;
      const quote = quotes.get(s);
      return quote ? citationLink(quote) : "";
    })
    .join("")
    .replaceAll(String.fromCharCode(0xa0), " ")
    .trim();
}

export function writeSegments(field: HTMLElement, segments: readonly Segment[], quotes: ReadonlyMap<number, Quote>) {
  field.replaceChildren(
    ...segments.flatMap((s): Node[] => {
      if (typeof s === "string") return [document.createTextNode(s)];
      const quote = quotes.get(s);
      return quote ? [makeChip(quote)] : [];
    }),
  );
}

function placeCaret(range: Range) {
  const selection = getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

export function focusEnd(field: HTMLElement) {
  field.focus({ preventScroll: true });
  const range = document.createRange();
  range.selectNodeContents(field);
  range.collapse(false);
  placeCaret(range);
}

export function insertChip(field: HTMLElement, chip: HTMLElement, at: Range | null) {
  field.focus({ preventScroll: true });
  const range = at && field.contains(at.endContainer) ? at.cloneRange() : null;
  const target = range ?? document.createRange();
  if (!range) target.selectNodeContents(field);
  target.collapse(false);
  const before = target.startContainer.nodeType === Node.TEXT_NODE ? (target.startContainer as Text).data.slice(0, target.startOffset) : "";
  const space = document.createTextNode(" ");
  target.insertNode(space);
  target.insertNode(chip);
  if (before && !/\s$/.test(before)) chip.before(" ");
  const caret = document.createRange();
  caret.setStartAfter(space);
  caret.collapse(true);
  placeCaret(caret);
}
