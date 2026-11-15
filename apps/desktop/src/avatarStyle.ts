/**
 * How bot avatars are colored: each bot's outline in its own color, or ink outlines with only the eyes in
 * color. Set as `data-avatars` on the root, which Avatar reads in CSS, so no component needs a prop.
 */
export type AvatarStyle = "color" | "mono";

export const AVATAR_STYLES: readonly { value: AvatarStyle; label: string; description: string }[] = [
  { value: "color", label: "Color", description: "Each bot in its own color." },
  { value: "mono", label: "Mono", description: "Bots in ink; only their eyes keep their color." },
];

const isAvatarStyle = (v: string | null): v is AvatarStyle => v === "color" || v === "mono";

export function readAvatarStyle(): AvatarStyle {
  try {
    const saved = localStorage.getItem("top.avatars");
    return isAvatarStyle(saved) ? saved : "color";
  } catch {
    return "color";
  }
}

/** Restyle every avatar and remember it. */
export function applyAvatarStyle(style: AvatarStyle) {
  document.documentElement.dataset.avatars = style;
  try {
    localStorage.setItem("top.avatars", style);
  } catch {
    // ignore
  }
}

// Before the first paint, so avatars never flash in the other style.
document.documentElement.dataset.avatars = readAvatarStyle();
