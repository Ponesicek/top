// The right-click menu. Electron shows none on its own, so without this a right-click in the message box
// (or anywhere) does nothing. The menu is the system's: spelling fixes for a misspelled word, then the
// usual editing commands, each enabled as Chromium reports for the spot clicked. Kept free of Electron
// imports so it runs under `node --test`.

/** Spelling fixes shown at most, like Chrome. */
const SUGGESTIONS = 5;

/**
 * What the menu needs from the page that was right-clicked.
 * @typedef {{ replaceMisspelling(word: string): void; session: { addWordToSpellCheckerDictionary(word: string): boolean } }} Target
 */

/**
 * The menu for a right-click, or an empty list when there's nothing to offer (then no menu opens).
 * @param {Pick<Electron.ContextMenuParams, "isEditable" | "selectionText" | "misspelledWord" | "dictionarySuggestions" | "editFlags">} params
 * @param {Target} target
 * @returns {Electron.MenuItemConstructorOptions[]}
 */
export function contextMenuTemplate(params, target) {
  /** @type {Electron.MenuItemConstructorOptions[]} */
  const items = [];
  if (params.isEditable && params.misspelledWord) {
    const word = params.misspelledWord;
    const suggestions = params.dictionarySuggestions.slice(0, SUGGESTIONS);
    for (const suggestion of suggestions) items.push({ label: suggestion, click: () => target.replaceMisspelling(suggestion) });
    if (!suggestions.length) items.push({ label: "No suggestions", enabled: false });
    items.push({ label: "Add to dictionary", click: () => target.session.addWordToSpellCheckerDictionary(word) }, { type: "separator" });
  }
  const flags = params.editFlags;
  if (params.isEditable) {
    items.push(
      { role: "cut", enabled: flags.canCut },
      { role: "copy", enabled: flags.canCopy },
      { role: "paste", enabled: flags.canPaste },
      { type: "separator" },
      { role: "selectAll", enabled: flags.canSelectAll },
    );
  } else if (params.selectionText.trim()) {
    items.push({ role: "copy", enabled: flags.canCopy });
  }
  return items;
}
