import type { BotId } from "@top/client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { move, nearest } from "../order.ts";

export type Group = "pinned" | "rest";

const TOUCH_HOLD_MS = 280;
const TOUCH_SLOP = 8;
const MOUSE_SLOP = 5;
/** After the hold, this much movement starts a drag. Holding still on instead opens the bot's menu (at 500 ms). */
const ARMED_SLOP = 3;

// A drag and a bot's long-press menu never both happen: the menu stays shut during a drag, and a menu that opens first
// ends the press before it becomes one.
let dragging = false;
let menuShown: (() => void) | undefined;
export const reordering = () => dragging;
export const menuOpened = () => menuShown?.();

type Gesture = {
  readonly id: BotId;
  readonly group: Group;
  readonly pointerId: number;
  readonly touch: boolean;
  readonly startX: number;
  readonly startY: number;
  active: boolean;
  /** A finger held still long enough: moving now drags. */
  armed?: boolean;
  timer?: ReturnType<typeof setTimeout>;
};

type Place = { readonly x: number; readonly y: number; readonly w: number; readonly h: number };

const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Drag to reorder the bots in the sidebar, within their group: with a mouse once it moves, with a finger after holding
 * still for a moment (so a swipe still scrolls). Alt+Shift+↑/↓ moves the focused bot. The order shows while dragging;
 * `onCommit` gets it when the drag ends.
 */
export function useSidebarReorder({
  groups,
  onCommit,
  nameOf,
}: {
  groups: Readonly<Record<Group, readonly BotId[]>>;
  onCommit: (group: Group, ids: readonly BotId[]) => void;
  nameOf: (id: BotId) => string;
}) {
  const navRef = useRef<HTMLElement>(null);
  const [preview, setPreview] = useState<{ group: Group; ids: readonly BotId[] }>();
  const [announcement, setAnnouncement] = useState("");
  const gesture = useRef<Gesture | undefined>(undefined);
  const places = useRef(new Map<string, Place>());
  const latest = useRef({ groups, onCommit, nameOf, preview });
  latest.current = { groups, onCommit, nameOf, preview };

  const shown = (group: Group): readonly BotId[] => (preview?.group === group ? preview.ids : groups[group]);

  const announce = useCallback((group: Group, id: BotId, ids: readonly BotId[]) => {
    const where = ids.indexOf(id) + 1;
    setAnnouncement(`${latest.current.nameOf(id)} moved to position ${where} of ${ids.length}${group === "pinned" ? " among pinned bots" : ""}.`);
  }, []);

  /** Moves a bot one place up or down in its group, from the keyboard or its menu. */
  const step = useCallback(
    (id: BotId, by: -1 | 1) => {
      const { groups: now, onCommit: commit } = latest.current;
      const group: Group = now.pinned.includes(id) ? "pinned" : "rest";
      const ids = now[group];
      const from = ids.indexOf(id);
      const to = from + by;
      if (from < 0 || to < 0 || to >= ids.length) return;
      const next = move(ids, from, to);
      commit(group, next);
      announce(group, id, next);
      requestAnimationFrame(() => navRef.current?.querySelector<HTMLElement>(`[data-bot="${id}"] button:not([data-delete])`)?.focus({ preventScroll: false }));
    },
    [announce],
  );

  const end = useCallback(
    (commit: boolean) => {
      const g = gesture.current;
      gesture.current = undefined;
      dragging = false;
      if (!g) return;
      clearTimeout(g.timer);
      document.documentElement.classList.remove("reordering");
      navRef.current?.querySelector(`[data-bot="${g.id}"]`)?.removeAttribute("data-dragging");
      if (!g.active) return;
      const shownIds = latest.current.preview?.group === g.group ? latest.current.preview.ids : undefined;
      setPreview(undefined);
      const before = latest.current.groups[g.group];
      if (commit && shownIds && shownIds.join() !== before.join()) {
        latest.current.onCommit(g.group, shownIds);
        announce(g.group, g.id, shownIds);
      }
      // The click that ends a drag isn't a click on the bot.
      const swallow = (e: Event) => {
        e.stopPropagation();
        e.preventDefault();
      };
      addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => removeEventListener("click", swallow, { capture: true }), 0);
    },
    [announce],
  );

  const activate = useCallback((g: Gesture) => {
    g.active = true;
    dragging = true;
    document.documentElement.classList.add("reordering");
    getSelection()?.removeAllRanges();
    navRef.current?.querySelector(`[data-bot="${g.id}"]`)?.setAttribute("data-dragging", "");
    if (g.touch) navigator.vibrate?.(8);
    setPreview({ group: g.group, ids: latest.current.groups[g.group] });
  }, []);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const g = gesture.current;
      if (!g || e.pointerId !== g.pointerId) return;
      const dx = e.clientX - g.startX;
      const dy = e.clientY - g.startY;
      if (!g.active) {
        const far = Math.hypot(dx, dy);
        if (g.touch && !g.armed) {
          if (far > TOUCH_SLOP) end(false);
          return;
        }
        if (far <= (g.touch ? ARMED_SLOP : MOUSE_SLOP)) return;
        activate(g);
        // The move that starts the drag counts too, from the order as it was.
      }
      e.preventDefault();
      const nav = navRef.current;
      const current = latest.current.preview ?? { group: g.group, ids: latest.current.groups[g.group] };
      if (!nav || !current) return;
      // Slots by where the bots sit in the layout, not where a slide shows them right now.
      const box = nav.getBoundingClientRect();
      const items = [...nav.querySelectorAll<HTMLElement>(`[data-reorder="${g.group}"]`)].filter((el) => places.current.has(el.dataset.bot!));
      const centers = items.map((el) => {
        const p = places.current.get(el.dataset.bot!)!;
        return { x: box.left - nav.scrollLeft + p.x + p.w / 2, y: box.top - nav.scrollTop + p.y + p.h / 2 };
      });
      const target = nearest({ x: e.clientX, y: e.clientY }, centers);
      const over = target < 0 ? undefined : Number(items[target]!.dataset.bot);
      if (over === undefined || over === g.id) return;
      const from = current.ids.indexOf(g.id);
      const to = current.ids.indexOf(over);
      if (from >= 0 && to >= 0) setPreview({ group: g.group, ids: move(current.ids, from, to) });
    };
    const onUp = (e: PointerEvent) => {
      if (gesture.current?.pointerId === e.pointerId) end(e.type === "pointerup");
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && gesture.current?.active) {
        e.preventDefault();
        e.stopPropagation();
        end(false);
      }
    };
    const onTouchMove = (e: TouchEvent) => {
      const g = gesture.current;
      if ((g?.active || g?.armed) && e.cancelable) e.preventDefault();
    };
    const onContextMenu = (e: Event) => {
      if (gesture.current?.active) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    menuShown = () => {
      if (!gesture.current?.active) end(false);
    };
    addEventListener("pointermove", onMove, { passive: false });
    addEventListener("pointerup", onUp);
    addEventListener("pointercancel", onUp);
    addEventListener("keydown", onKey, { capture: true });
    addEventListener("touchmove", onTouchMove, { passive: false });
    addEventListener("contextmenu", onContextMenu, { capture: true });
    return () => {
      removeEventListener("pointermove", onMove);
      removeEventListener("pointerup", onUp);
      removeEventListener("pointercancel", onUp);
      removeEventListener("keydown", onKey, { capture: true });
      removeEventListener("touchmove", onTouchMove);
      removeEventListener("contextmenu", onContextMenu, { capture: true });
      menuShown = undefined;
      end(false);
    };
  }, [activate, end]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (gesture.current || (e.pointerType === "mouse" && e.button !== 0) || e.ctrlKey || e.metaKey) return;
    const target = e.target as HTMLElement;
    if (target.closest("[data-delete]")) return;
    const item = target.closest<HTMLElement>("[data-reorder]");
    if (!item) return;
    const g: Gesture = {
      id: Number(item.dataset.bot),
      group: item.dataset.reorder as Group,
      pointerId: e.pointerId,
      touch: e.pointerType !== "mouse",
      startX: e.clientX,
      startY: e.clientY,
      active: false,
    };
    if (g.touch)
      g.timer = setTimeout(() => {
        g.armed = true;
      }, TOUCH_HOLD_MS);
    gesture.current = g;
  }, []);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
      const item = (e.target as HTMLElement).closest<HTMLElement>("[data-reorder]");
      if (!item) return;
      e.preventDefault();
      e.stopPropagation();
      step(Number(item.dataset.bot), e.key === "ArrowUp" ? -1 : 1);
    },
    [step],
  );

  // Bots slide to their new places rather than jump, unless motion is reduced. Places are kept relative to the list's
  // content, after every render, so scrolling or a resize in between doesn't count as a move.
  const lastOrder = useRef("");
  const order = `${shown("pinned").join()}|${shown("rest").join()}`;
  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const box = nav.getBoundingClientRect();
    const changed = lastOrder.current !== order;
    const moved = lastOrder.current !== "" && changed && !reducedMotion();
    lastOrder.current = order;
    const next = new Map<string, Place>();
    for (const el of nav.querySelectorAll<HTMLElement>("[data-reorder]")) {
      if (changed) for (const slide of el.getAnimations()) slide.cancel();
      const rect = el.getBoundingClientRect();
      const before = places.current.get(el.dataset.bot!);
      // Mid-slide, the box is where the slide is; its place is where it ends.
      const running = !changed && before && el.getAnimations().length > 0;
      const place = running ? before : { x: rect.left - box.left + nav.scrollLeft, y: rect.top - box.top + nav.scrollTop, w: rect.width, h: rect.height };
      next.set(el.dataset.bot!, place);
      if (!moved || !before) continue;
      const dx = before.x - place.x;
      const dy = before.y - place.y;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: 160, easing: "cubic-bezier(0.2, 0, 0, 1)" });
    }
    places.current = next;
  });

  return { navRef, shown, step, announcement, onPointerDown, onKeyDown, dragging: preview !== undefined };
}
