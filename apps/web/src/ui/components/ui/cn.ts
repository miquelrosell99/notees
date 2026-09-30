/**
 * Class name utility
 *
 * A lightweight conditional class name joiner. Notees uses a custom
 * design-token CSS system, not Tailwind, so no merge semantics are needed.
 *
 * Usage:
 *   cn('btn', variant === 'primary' && 'btn--primary', className)
 */
export type ClassValue = string | false | null | undefined;

export function cn(...inputs: ClassValue[]): string {
  return inputs.filter(Boolean).join(' ');
}
