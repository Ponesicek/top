// The right-click menu. Electron shows none on its own, and its native menu on Linux is drawn in the
// system's GTK theme (a white square over the dark app), so the page draws it instead
// (src/components/EditMenu.tsx). Only this process gets the spelling suggestions, so it decides what the
// menu offers and carries out the action the page picks, by name: the page never sends the text to put
// in. Kept free of Electron imports so it runs under `node --test`.

/** Spelling fixes shown at most, like Chrome. */
const SUGGESTIONS = 5;

/**
 * What the page's menu shows, top to bottom. `action` is what `runContextMenuAction` takes back.
 * @typedef {{ action: string; label?: string; enabled: boolean } | { separator: true }} ContextMenuItem
 */

/**
 * The part of a right-click this reads.
 * @typedef {Pick<Electron.ContextMenuParams, "isEditable" | "selectionText" | "misspelledWord" | "dictionarySuggestions" | "editFlags">} Click
 */

/**
 * The page that was right-clicked: Electron's editing commands run on its focused field.
 * @typedef {{ cut(): void; copy(): void; paste(): void; selectAll(): void; replaceMisspelling(word: string): void; session: { addWordToSpellCheckerDictionary(word: string): boolean } }} Target
 */

/**
 * The menu for a right-click, or an empty list when there's nothing to offer (then no menu opens).
 * @param {Click} params
 * @returns {ContextMenuItem[]}
 */
export function contextMenuItems(params) {
  /** @type {ContextMenuItem[]} */
  const items = [];
  if (params.isEditable && params.misspelledWord) {
    const suggestions = params.dictionarySuggestions.slice(0, SUGGESTIONS);
    for (const [i, word] of suggestions.entries()) items.push({ action: `replace:${i}`, label: word, enabled: true });
    if (!suggestions.length) items.push({ action: "no-suggestions", enabled: false });
    items.push({ action: "add-word", enabled: true }, { separator: true });
  }
  const flags = params.editFlags;
  if (params.isEditable) {
    items.push(
      { action: "cut", enabled: flags.canCut },
      { action: "copy", enabled: flags.canCopy },
      { action: "paste", enabled: flags.canPaste },
      { separator: true },
      { action: "select-all", enabled: flags.canSelectAll },
    );
  } else if (params.selectionText.trim()) {
    items.push({ action: "copy", enabled: flags.canCopy });
  }
  return items;
}

/**
 * Carry out `action` from the menu `params` opened, if that menu offered it enabled.
 * @param {Click} params
 * @param {unknown} action
 * @param {Target} target
 * @returns {boolean} whether it ran
 */
export function runContextMenuAction(params, action, target) {
  const offered = contextMenuItems(params).some((item) => "action" in item && item.enabled && item.action === action);
  if (!offered) return false;
  const replace = /^replace:(\d)$/.exec(String(action));
  if (replace) target.replaceMisspelling(params.dictionarySuggestions[Number(replace[1])] ?? "");
  else if (action === "add-word") target.session.addWordToSpellCheckerDictionary(params.misspelledWord);
  else if (action === "cut") target.cut();
  else if (action === "copy") target.copy();
  else if (action === "paste") target.paste();
  else if (action === "select-all") target.selectAll();
  else return false;
  return true;
}
