import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import { cn } from "../../lib/utils.ts";

function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        "inline-flex h-5.5 w-9 shrink-0 items-center rounded-full bg-input p-0.5 outline-hidden transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-primary data-checked:bg-primary data-disabled:opacity-50 [-webkit-app-region:no-drag]",
        className,
      )}
      data-slot="switch"
      {...props}
    >
      <SwitchPrimitive.Thumb
        className="size-4.5 rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.2)] transition-transform duration-150 ease-out data-checked:translate-x-3.5 motion-reduce:transition-none"
        data-slot="switch-thumb"
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
