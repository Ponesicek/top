import { Menu } from "@base-ui/react/menu";
import { useEffect, useRef, useState } from "react";
import { type ContextMenu, contextMenu } from "../bridge.ts";

// The bot menu's look (Sidebar.tsx), so every right-click menu in the app matches.
const POPUP =
  "min-w-48 origin-(--transform-origin) rounded-xl bg-popover p-1 text-foreground shadow-popover outline-none transition duration-100 data-ending-style:scale-98 data-ending-style:opacity-0 data-starting-style:scale-98 data-starting-style:opacity-0 data-instant:duration-0 [-webkit-app-region:no-drag]";
const ITEM =
  "flex cursor-default items-center justify-between gap-6 rounded-lg px-2.5 py-1.75 text-small leading-none font-label outline-none select-none data-disabled:text-muted-foreground data-highlighted:bg-foreground/7";

const LABELS: Record<string, string> = {
  "no-suggestions": "No suggestions",
  "add-word": "Add to dictionary",
  cut: "Cut",
  copy: "Copy",
  paste: "Paste",
  "select-all": "Select all",
};
const mac = navigator.userAgent.includes("Mac");
const KEYS: Record<string, string> = { cut: "X", copy: "C", paste: "V", "select-all": "A" };

/** Puts focus and the selection back where the right-click left them, for the edit to act on. */
function rememberFocus(): () => void {
  const element = document.activeElement;
  const selection = getSelection();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange()) : [];
  const field = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element : undefined;
  const span = field && ([field.selectionStart, field.selectionEnd, field.selectionDirection] as const);
  return () => {
    if (element instanceof HTMLElement) element.focus({ preventScroll: true });
    if (field && span && span[0] !== null && span[1] !== null) field.setSelectionRange(span[0], span[1], span[2] ?? undefined);
    else if (selection && ranges.length) {
      selection.removeAllRanges();
      for (const range of ranges) selection.addRange(range);
    }
  };
}

/**
 * The desktop app's right-click menu: spelling fixes, then cut, copy, paste and select all. Electron
 * decides what it offers and runs the edit (electron/context-menu.js); this draws it in the app's own
 * look. A browser keeps its own menu, so outside the desktop app this renders nothing.
 */
export function EditMenu() {
  const [menu, setMenu] = useState<ContextMenu>();
  const [open, setOpen] = useState(false);
  const restore = useRef<() => void>(undefined);
  /** What to do once the menu has closed, when base-ui is done moving focus: the edit runs on the field. */
  const afterClose = useRef<() => void>(undefined);
  useEffect(
    () =>
      contextMenu?.onOpen((next) => {
        restore.current = rememberFocus();
        afterClose.current = undefined;
        setMenu(next);
        setOpen(true);
      }),
    [],
  );
  if (!contextMenu || !menu) return null;
  const run = contextMenu.run;
  const anchor = { getBoundingClientRect: () => DOMRect.fromRect({ x: menu.x, y: menu.y, width: 0, height: 0 }) };
  return (
    <Menu.Root
      open={open}
      modal={false}
      onOpenChange={(next, details) => {
        setOpen(next);
        // Escape gives the field back its focus and selection; a click elsewhere goes where it was aimed.
        if (!next && details.reason === "escape-key") afterClose.current = restore.current;
      }}
      onOpenChangeComplete={(isOpen) => {
        if (isOpen) return;
        const then = afterClose.current;
        afterClose.current = undefined;
        then?.();
      }}
    >
      <Menu.Portal>
        <Menu.Positioner anchor={anchor} side="bottom" align="start" collisionPadding={8} className="z-50">
          <Menu.Popup className={POPUP} finalFocus={false} onContextMenu={(e) => e.preventDefault()}>
            {menu.items.map((item, i) =>
              "separator" in item ? (
                // biome-ignore lint/suspicious/noArrayIndexKey: the menu is rebuilt whole on each right-click
                <Menu.Separator key={i} className="mx-1.5 my-1 h-px bg-border" />
              ) : (
                <Menu.Item
                  key={item.action}
                  className={ITEM}
                  disabled={!item.enabled}
                  onClick={() => {
                    afterClose.current = () => {
                      restore.current?.();
                      run(item.action);
                    };
                  }}
                >
                  <span>{item.label ?? LABELS[item.action] ?? item.action}</span>
                  {KEYS[item.action] && (
                    <kbd className="font-sans text-meta text-muted-foreground">{mac ? `⌘${KEYS[item.action]}` : `Ctrl+${KEYS[item.action]}`}</kbd>
                  )}
                </Menu.Item>
              ),
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
