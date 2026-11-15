import assert from "node:assert/strict";
import { test } from "node:test";
import { contextMenuTemplate } from "./context-menu.js";

const flags = { canUndo: true, canRedo: true, canCut: true, canCopy: true, canPaste: true, canDelete: true, canSelectAll: true, canEditRichly: false };

/** A right-click, as Electron describes it, with `over` changed. */
function click(over = {}) {
  return { isEditable: true, selectionText: "", misspelledWord: "", dictionarySuggestions: [], editFlags: flags, ...over };
}

function fakeTarget() {
  /** @type {string[]} */
  const replaced = [];
  /** @type {string[]} */
  const added = [];
  return {
    replaced,
    added,
    replaceMisspelling: (/** @type {string} */ word) => void replaced.push(word),
    session: { addWordToSpellCheckerDictionary: (/** @type {string} */ word) => added.push(word) > 0 },
  };
}

/** Each item as a short string: its role or label, `-` for a separator, `(off)` when disabled. */
const shape = (/** @type {Electron.MenuItemConstructorOptions[]} */ items) =>
  items.map((i) => (i.type === "separator" ? "-" : `${i.role ?? i.label}${i.enabled === false ? " (off)" : ""}`));

test("an editable field gets cut, copy, paste and select all", () => {
  assert.deepEqual(shape(contextMenuTemplate(click(), fakeTarget())), ["cut", "copy", "paste", "-", "selectAll"]);
});

test("commands the field can't do right now are disabled, not hidden", () => {
  const items = contextMenuTemplate(click({ editFlags: { ...flags, canCut: false, canCopy: false } }), fakeTarget());
  assert.deepEqual(shape(items), ["cut (off)", "copy (off)", "paste", "-", "selectAll"]);
});

test("a misspelled word offers its fixes first, and picking one replaces it", () => {
  const target = fakeTarget();
  const items = contextMenuTemplate(click({ misspelledWord: "teh", dictionarySuggestions: ["the", "tech", "ten", "tea", "tee", "toe"] }), target);
  assert.deepEqual(shape(items), ["the", "tech", "ten", "tea", "tee", "Add to dictionary", "-", "cut", "copy", "paste", "-", "selectAll"]);
  items[1]?.click?.(/** @type {any} */ ({}), undefined, /** @type {any} */ ({}));
  assert.deepEqual(target.replaced, ["tech"]);
});

test("a misspelled word with no fixes says so, and can be added to the dictionary", () => {
  const target = fakeTarget();
  const items = contextMenuTemplate(click({ misspelledWord: "grdfgrdgr" }), target);
  assert.deepEqual(shape(items).slice(0, 3), ["No suggestions (off)", "Add to dictionary", "-"]);
  items[1]?.click?.(/** @type {any} */ ({}), undefined, /** @type {any} */ ({}));
  assert.deepEqual(target.added, ["grdfgrdgr"]);
});

test("selected text outside a field can be copied", () => {
  assert.deepEqual(shape(contextMenuTemplate(click({ isEditable: false, selectionText: "hello" }), fakeTarget())), ["copy"]);
});

test("nothing selected outside a field opens no menu", () => {
  assert.deepEqual(contextMenuTemplate(click({ isEditable: false, selectionText: "  " }), fakeTarget()), []);
});
