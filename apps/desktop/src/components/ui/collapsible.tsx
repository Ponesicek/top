import { Collapsible as CollapsiblePrimitive } from "@base-ui/react/collapsible";
import { cn } from "../../lib/utils.ts";

function Collapsible(props: CollapsiblePrimitive.Root.Props) {
  return <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />;
}

function CollapsibleTrigger({ className, ...props }: CollapsiblePrimitive.Trigger.Props) {
  return <CollapsiblePrimitive.Trigger className={cn("cursor-pointer", className)} data-slot="collapsible-trigger" {...props} />;
}

/** No height animation: panels live in the virtualized transcript, which re-measures rows as they resize. */
function CollapsiblePanel(props: CollapsiblePrimitive.Panel.Props) {
  return <CollapsiblePrimitive.Panel data-slot="collapsible-panel" {...props} />;
}

export { Collapsible, CollapsiblePanel, CollapsibleTrigger };
