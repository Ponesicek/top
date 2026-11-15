import assert from "node:assert/strict";
import { test } from "node:test";
import { contextMenuItems, runContextMenuAction } from "./context-menu.js";

const flags = { canUndo: true, canRedo: true, canCut: true, canCopy: true, canPaste: true, canDelete: true, canSelectAll: true, canEditRichly: false };

/** A right-click, as Electron describes it, with `over` changed. */
function click(over = {}) {
  return { isEditable: true, selectionText: "", misspelledWord: "", dictionarySuggestions: /** @type {string[]} */ ([]), editFlags: flags, ...over };
}

/** A page that records which editing command ran. */
function fakeTarget() {
  /** @type {string[]} */
  const ran = [];
  const record = (/** @type {string} */ name) => () => void ran.push(name);
  return {
    ran,
    cut: record("cut"),
    copy: record("copy"),
    paste: record("paste"),
    selectAll: record("selectAll"),
    replaceMisspelling: (/** @type {string} */ word) => void ran.push(`replace ${word}`),
    session: { addWordToSpellCheckerDictionary: (/** @type {string} */ word) => ran.push(`add ${word}`) > 0 },
  };
}

/** Each item as a short string: its action or label, `-` for a separator, `(off)` when disabled. */
const shape = (/** @type {import("./context-menu.js").ContextMenuItem[]} */ items) =>
  items.map((i) => ("separator" in i ? "-" : `${i.label ?? i.action}${i.enabled ? "" : " (off)"}`));

test("an editable field gets cut, copy, paste and select all", () => {
  assert.deepEqual(shape(contextMenuItems(click())), ["cut", "copy", "paste", "-", "select-all"]);
});

test("commands the field can't do right now are disabled, not hidden", () => {
  assert.deepEqual(shape(contextMenuItems(click({ editFlags: { ...flags, canCut: false, canCopy: false } }))), [
    "cut (off)",
    "copy (off)",
    "paste",
    "-",
    "select-all",
  ]);
});

test("a misspelled word offers up to five fixes first, then adding it to the dictionary", () => {
  const items = contextMenuItems(click({ misspelledWord: "teh", dictionarySuggestions: ["the", "tech", "ten", "tea", "tee", "toe"] }));
  assert.deepEqual(shape(items), ["the", "tech", "ten", "tea", "tee", "add-word", "-", "cut", "copy", "paste", "-", "select-all"]);
});

test("a misspelled word with no fixes says so", () => {
  assert.deepEqual(shape(contextMenuItems(click({ misspelledWord: "grdfgrdgr" }))).slice(0, 3), ["no-suggestions (off)", "add-word", "-"]);
});

test("selected text outside a field can be copied; nothing selected opens no menu", () => {
  assert.deepEqual(shape(contextMenuItems(click({ isEditable: false, selectionText: "hello" }))), ["copy"]);
  assert.deepEqual(contextMenuItems(click({ isEditable: false, selectionText: "  " })), []);
});

test("picking a fix replaces the word with that suggestion, and add-word adds the clicked word", () => {
  const params = click({ misspelledWord: "teh", dictionarySuggestions: ["the", "tech"] });
  const target = fakeTarget();
  assert.equal(runContextMenuAction(params, "replace:1", target), true);
  assert.equal(runContextMenuAction(params, "add-word", target), true);
  assert.deepEqual(target.ran, ["replace tech", "add teh"]);
});

test("editing actions run Electron's own commands", () => {
  const target = fakeTarget();
  for (const action of ["cut", "copy", "paste", "select-all"]) runContextMenuAction(click(), action, target);
  assert.deepEqual(target.ran, ["cut", "copy", "paste", "selectAll"]);
});

test("the page can only pick what the menu offered, enabled", () => {
  const target = fakeTarget();
  const params = click({ misspelledWord: "teh", dictionarySuggestions: ["the"], editFlags: { ...flags, canPaste: false } });
  assert.equal(runContextMenuAction(params, "paste", target), false);
  assert.equal(runContextMenuAction(params, "replace:3", target), false);
  assert.equal(runContextMenuAction(params, "no-suggestions", target), false);
  assert.equal(runContextMenuAction(click(), "add-word", target), false);
  assert.equal(runContextMenuAction(click(), { toString: () => "cut" }, target), false);
  assert.deepEqual(target.ran, []);
});
