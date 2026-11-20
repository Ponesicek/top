import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils.ts";

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-full font-semibold text-small leading-none outline-hidden transition duration-90 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-default [&_svg]:pointer-events-none [&_svg]:shrink-0 [-webkit-app-region:no-drag]",
  {
    defaultVariants: { size: "default", variant: "default" },
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground not-disabled:hover:bg-primary-hover disabled:bg-secondary disabled:text-muted-foreground",
        destructive: "bg-destructive text-white not-disabled:hover:bg-destructive-foreground disabled:bg-secondary disabled:text-muted-foreground",
        outline:
          "text-foreground inset-ring inset-ring-input not-disabled:hover:bg-secondary disabled:bg-secondary disabled:text-muted-foreground disabled:shadow-none",
        ghost: "text-muted-foreground hover:bg-foreground/7 hover:text-foreground",
        "ghost-destructive": "text-muted-foreground hover:bg-destructive-surface hover:text-destructive-foreground",
        stop: "bg-destructive-surface text-destructive-foreground hover:bg-destructive hover:text-white",
        link: "rounded-none font-label text-meta leading-snug text-link not-disabled:hover:underline underline-offset-2 disabled:text-muted-foreground",
      },
      size: {
        default: "h-9 pr-3.5 pl-3",
        wide: "h-9 px-4",
        xs: "h-6.5 gap-1.25 px-1.5 text-micro",
        icon: "size-9 active:not-disabled:scale-94 narrow:size-11",
        "icon-xs": "size-6.5",
        "icon-row": "h-5.5 w-6 rounded-md",
        link: "h-auto p-0",
      },
    },
  },
);

type ButtonProps = useRender.ComponentProps<"button"> & VariantProps<typeof buttonVariants>;

function Button({ className, variant, size, render, ...props }: ButtonProps) {
  const defaultProps = { type: "button" as const, className: cn(buttonVariants({ variant, size }), className), "data-slot": "button" };
  return useRender({ defaultTagName: "button", render, props: mergeProps<"button">(defaultProps, props) });
}

export { Button, type ButtonProps, buttonVariants };
