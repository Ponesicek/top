import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import type { ReactElement, ReactNode } from "react";
import { cn } from "../../lib/utils.ts";

const TooltipProvider = TooltipPrimitive.Provider;

/** A hover/focus label for an icon-only control. `children` is the trigger element itself. */
function Tooltip({
  content,
  children,
  side = "top",
  align = "center",
  className,
}: {
  content: ReactNode;
  children: ReactElement;
  side?: TooltipPrimitive.Positioner.Props["side"];
  align?: TooltipPrimitive.Positioner.Props["align"];
  className?: string;
}) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger render={children} data-slot="tooltip-trigger" />
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Positioner side={side} align={align} sideOffset={6} className="pointer-events-none z-140">
          <TooltipPrimitive.Popup
            className={cn(
              "max-w-72 origin-(--transform-origin) rounded-lg bg-popover px-2 py-1 text-xs leading-snug text-secondary-foreground shadow-popover transition duration-100 data-ending-style:scale-98 data-ending-style:opacity-0 data-instant:duration-0 data-starting-style:scale-98 data-starting-style:opacity-0",
              className,
            )}
            data-slot="tooltip-popup"
          >
            {content}
          </TooltipPrimitive.Popup>
        </TooltipPrimitive.Positioner>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

export { Tooltip, TooltipProvider };
