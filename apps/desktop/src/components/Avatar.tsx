import type { BotStatus } from "@top/client";
import { memo } from "react";
import { cn } from "../lib/utils.ts";

/**
 * Each bot keeps one color everywhere: picked from its name, so it survives restarts and reorders.
 * Eight distinct families; amber, red and orange are left out because they mean thinking, stop and accent.
 * White letters: >= 3.9:1 at the light stop, >= 4.9:1 at the center where the letter sits.
 */
const HUES = {
  cocoa: "[--h1:#9a6646] [--h2:#74472c]",
  sky: "[--h1:#3a74e8] [--h2:#1f4fc4]",
  emerald: "[--h1:#2f9a4a] [--h2:#1d7434]",
  cyan: "[--h1:#0e98a4] [--h2:#0a6b75]",
  indigo: "[--h1:#6070f5] [--h2:#3d42c9]",
  violet: "[--h1:#8a5cf5] [--h2:#6233d6]",
  fuchsia: "[--h1:#c24ed6] [--h2:#9420a8]",
  rose: "[--h1:#e0406c] [--h2:#b51d47]",
} as const;
const NAMES = Object.keys(HUES) as (keyof typeof HUES)[];

export function botHue(name: string): keyof typeof HUES {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return NAMES[h % NAMES.length]!;
}

const SIZES = {
  sm: "size-7 text-meta",
  md: "size-9 text-body",
  lg: "size-14 text-[22px]",
} as const;

/**
 * The bot's initial on its color. A failed bot gets a red presence dot, ringed in `--avatar-ring` (the
 * color behind the avatar) so it reads as cut out of the circle.
 */
export const Avatar = memo(function Avatar({
  name,
  status,
  size = "md",
  title,
  className,
}: {
  name: string;
  status?: BotStatus;
  size?: keyof typeof SIZES;
  title?: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "relative grid flex-none place-items-center rounded-full bg-linear-145/srgb from-(--h1) to-(--h2) leading-none font-heading tracking-name text-white text-shadow-[0_1px_1px_rgba(0,0,0,0.18)] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14),inset_0_1px_0_rgba(255,255,255,0.2)] select-none [filter:var(--avatar-filter)]",
        SIZES[size],
        HUES[botHue(name)],
        className,
      )}
      aria-hidden
      title={title}
    >
      {name.slice(0, 1).toUpperCase()}
      {status === "failed" && (
        <i className="absolute -right-0.5 -bottom-0.5 size-3 rounded-full border-[2.5px] border-(--avatar-ring,var(--color-sidebar)) bg-destructive" />
      )}
    </span>
  );
});
