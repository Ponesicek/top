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

export function applyAvatarStyle(style: AvatarStyle) {
  document.documentElement.dataset.avatars = style;
  try {
    localStorage.setItem("top.avatars", style);
  } catch {}
}

document.documentElement.dataset.avatars = readAvatarStyle();
