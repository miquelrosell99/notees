/**
 * Class name utility — clsx + tailwind-merge.
 *
 * The shadcn bridge needs merge semantics (cn(buttonVariants(), className)
 * must let the caller's className win over the variant's); the rest of the
 * app uses it as the plain conditional joiner it always was — twMerge only
 * resolves conflicting Tailwind utilities and passes every other class
 * through untouched, so both uses coexist.
 *
 * The app's type scale carries custom names (--font-size-button and the
 * 3xs/…/hero family) that tailwind-merge doesn't know out of the box, so
 * it would mistake `text-button` for a color and drop a real color like
 * `text-on-error` as a conflict. Registering the names as font sizes keeps
 * color and size utilities in their own conflict groups.
 */
import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

export type { ClassValue };

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [
        {
          text: [
            "3xs",
            "2xs",
            "button",
            "base",
            "body-lg",
            "body-xl",
            "title-lg",
            "lead",
            "hero",
          ],
        },
      ],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
