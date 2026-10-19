/**
 * Class name utility — clsx + tailwind-merge.
 *
 * The shadcn bridge needs merge semantics (cn(buttonVariants(), className)
 * must let the caller's className win over the variant's); the rest of the
 * app uses it as the plain conditional joiner it always was — twMerge only
 * resolves conflicting Tailwind utilities and passes every other class
 * through untouched, so both uses coexist.
 */
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export type { ClassValue };

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
