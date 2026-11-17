import { type CxOptions, cx } from "class-variance-authority";
import { extendTailwindMerge } from "tailwind-merge";

const twMerge = extendTailwindMerge({
  extend: { theme: { text: ["micro", "meta", "small", "body"] } },
});

export function cn(...inputs: CxOptions) {
  return twMerge(cx(inputs));
}
