import { Field as FieldPrimitive } from "@base-ui/react/field";
import { Input as InputPrimitive } from "@base-ui/react/input";
import { mergeProps } from "@base-ui/react/merge-props";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils.ts";

const CONTROL_CLASS =
  "w-full rounded-field bg-background px-3 py-2.25 text-[14.5px] leading-normal text-foreground inset-ring inset-ring-input outline-none transition-shadow duration-90 placeholder:text-muted-foreground focus:inset-ring-primary focus:shadow-focus";

function Field({ className, ...props }: FieldPrimitive.Root.Props) {
  return <FieldPrimitive.Root className={cn("flex flex-col gap-1.5", className)} data-slot="field" {...props} />;
}

function FieldLabel({ className, ...props }: FieldPrimitive.Label.Props) {
  return (
    <FieldPrimitive.Label className={cn("text-code leading-tight font-semibold text-secondary-foreground", className)} data-slot="field-label" {...props} />
  );
}

function FieldHint({ className, ...props }: ComponentProps<"span">) {
  return <span className={cn("font-book text-muted-foreground", className)} data-slot="field-hint" {...props} />;
}

function Input({ className, ...props }: InputPrimitive.Props) {
  return <InputPrimitive className={cn(CONTROL_CLASS, className)} data-slot="input" {...props} />;
}

function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return (
    <FieldPrimitive.Control
      render={(defaultProps) => (
        <textarea
          {...mergeProps<"textarea">(defaultProps, props)}
          className={cn(CONTROL_CLASS, "max-h-80 min-h-23 resize-y", className)}
          data-slot="textarea"
        />
      )}
    />
  );
}

export { Field, FieldHint, FieldLabel, Input, Textarea };
