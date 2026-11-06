import { type CxOptions, cx } from "class-variance-authority";
import { extendTailwindMerge } from "tailwind-merge";

// Register the app's type scale (styles.css @theme) so tailwind-merge treats text-meta as a font size, not a color.
const twMerge = extendTailwindMerge({
  extend: { theme: { text: ["micro", "meta", "small", "body"] } },
});

/** Class names, conditionally joined; later Tailwind classes win over earlier ones that conflict. */
export function cn(...inputs: CxOptions) {
  return twMerge(cx(inputs));
}
