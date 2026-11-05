import { memo } from "react";
import type { BotStatus } from "@top/client";

/**
 * Each bot keeps one color everywhere: picked from its name, so it survives restarts and reorders.
 * Eight distinct families; amber, red and orange are left out because they mean thinking, stop and accent.
 */
const HUES = ["cocoa", "sky", "emerald", "cyan", "indigo", "violet", "fuchsia", "rose"] as const;

export function botHue(name: string): (typeof HUES)[number] {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return HUES[h % HUES.length]!;
}

export const Avatar = memo(function Avatar({ name, status, size = "md", title }: { name: string; status?: BotStatus; size?: "sm" | "md" | "lg"; title?: string }) {
  return (
    <span className={`avatar a-${size} hue-${botHue(name)}${status ? ` s-${status}` : ""}`} aria-hidden title={title}>
      {name.slice(0, 1).toUpperCase()}
      {status && <i className="presence" />}
    </span>
  );
});
