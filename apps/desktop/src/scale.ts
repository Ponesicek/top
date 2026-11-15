/**
 * Interface size: the whole window zoomed, as a browser's Ctrl+/Ctrl- does, so text stays sharp and
 * layout measures in real sizes. Only the desktop app can (electron/preload.cjs); in a browser, its own
 * zoom does the same, and the setting isn't shown.
 */
import { desktop } from "./bridge.ts";

export const canScale = desktop !== undefined;

export const SCALES = [0.8, 0.9, 1, 1.1, 1.25, 1.5] as const;
export type Scale = (typeof SCALES)[number];

const isScale = (value: number): value is Scale => (SCALES as readonly number[]).includes(value);

export function readScale(): Scale {
  try {
    const saved = Number(localStorage.getItem("top.scale"));
    return isScale(saved) ? saved : 1;
  } catch {
    return 1;
  }
}

/** Zoom the window and remember it. */
export function applyScale(scale: Scale) {
  desktop?.setZoomFactor(scale);
  try {
    localStorage.setItem("top.scale", String(scale));
  } catch {
    // ignore
  }
}

/** The next size up (`1`) or down (`-1`) from `scale`, stopping at the ends. */
export function stepScale(scale: Scale, direction: 1 | -1): Scale {
  const i = SCALES.indexOf(scale);
  return SCALES[Math.min(SCALES.length - 1, Math.max(0, i + direction))]!;
}

// Before the first paint, so the app never flashes at 100%.
desktop?.setZoomFactor(readScale());
