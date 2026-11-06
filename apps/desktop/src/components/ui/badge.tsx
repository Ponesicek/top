import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils.ts";

const badgeVariants = cva("inline-flex shrink-0 items-center whitespace-nowrap rounded-full font-semibold leading-none [&_svg]:shrink-0", {
  defaultVariants: { size: "default", variant: "primary" },
  variants: {
    variant: {
      primary: "bg-primary-soft text-link",
      success: "bg-success-surface/70 text-success-foreground",
      warning: "bg-warning-surface text-warning-foreground",
      tool: "bg-tool-surface text-tool-foreground",
      destructive: "bg-destructive-surface text-destructive-foreground",
    },
    size: {
      default: "gap-1 px-1.75 py-0.75 text-micro",
      md: "gap-1 px-2 py-1 text-micro",
      lg: "gap-1.5 py-1.25 pr-2.25 pl-2 text-micro",
      xl: "gap-1.5 px-2.5 py-1.5 font-label text-meta leading-none",
    },
  },
});

type BadgeProps = useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants>;

function Badge({ className, variant, size, render, ...props }: BadgeProps) {
  const defaultProps = { className: cn(badgeVariants({ variant, size }), className), "data-slot": "badge" };
  return useRender({ defaultTagName: "span", render, props: mergeProps<"span">(defaultProps, props) });
}

export { Badge, badgeVariants };
