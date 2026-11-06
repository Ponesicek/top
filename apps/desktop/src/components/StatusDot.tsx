import type { BotStatus } from "@top/client";
import { cn } from "../lib/utils.ts";

/**
 * A bot's state as a 7px mark: a hollow ring when idle (a solid blue dot when it has something new),
 * amber while thinking, a spinning blue arc while a tool runs. `pulse` (the header) breathes a ring out
 * of the dot so the color never fades into "idle"; the sidebar's dots sit still beside their label.
 */
export function StatusDot({ status, fresh = false, pulse = false }: { status: BotStatus; fresh?: boolean; pulse?: boolean }) {
  if (status === "tool")
    return <i className="size-2 flex-none animate-spin rounded-full border-[1.5px] border-tool border-r-transparent motion-reduce:animate-none" />;
  if (status === "idle")
    return <i className={cn("size-[7px] flex-none rounded-full", fresh ? "bg-info shadow-[0_0_0_2px_color-mix(in_srgb,var(--color-info)_18%,transparent)]" : "shadow-[inset_0_0_0_1.5px_var(--color-muted-foreground)]")} />;
  const amber = status === "thinking" || status === "retrying";
  if (pulse)
    return <i className={cn("size-[7px] flex-none animate-ring rounded-full bg-(--dot) motion-reduce:animate-none", amber ? "[--dot:var(--color-warning)]" : "[--dot:var(--color-destructive)]")} />;
  // The sidebar says "Failed" in a red pill instead.
  if (!amber) return null;
  return <i className="size-[7px] flex-none rounded-full bg-warning shadow-[0_0_0_2px_var(--color-warning-surface)]" />;
}
