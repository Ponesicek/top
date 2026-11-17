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

export function applyScale(scale: Scale) {
  desktop?.setZoomFactor(scale);
  try {
    localStorage.setItem("top.scale", String(scale));
  } catch {}
}

export function stepScale(scale: Scale, direction: 1 | -1): Scale {
  const i = SCALES.indexOf(scale);
  return SCALES[Math.min(SCALES.length - 1, Math.max(0, i + direction))]!;
}

desktop?.setZoomFactor(readScale());
