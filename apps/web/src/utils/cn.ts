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
 *
 * Same failure mode one group over: the border-width scale names
 * (medium/thick/extra-thick) read as border COLORs to the default parser,
 * so `border-thick border-outline-variant` silently dropped the width — an
 * invisible Spinner arc (border-width 0, the loading button "expands but
 * shows no animation"). Registering them as widths keeps width, style, and
 * color utilities in their own conflict groups.
 */
import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

export type { ClassValue };

/** The custom border-width scale names (tailwind.config.ts borderWidth). */
const BORDER_WIDTH_NAMES = ["medium", "thick", "extra-thick"] as const;

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
      "border-w": [
        { border: [...BORDER_WIDTH_NAMES] },
        { "border-x": [...BORDER_WIDTH_NAMES] },
        { "border-y": [...BORDER_WIDTH_NAMES] },
        { "border-t": [...BORDER_WIDTH_NAMES] },
        { "border-b": [...BORDER_WIDTH_NAMES] },
        { "border-l": [...BORDER_WIDTH_NAMES] },
        { "border-r": [...BORDER_WIDTH_NAMES] },
      ],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
