/**
 * Class name utility
 *
 * A lightweight wrapper around `clsx` for conditional class name merging.
 * Intentionally does NOT use `tailwind-merge` — Notees uses a custom
 * design-token CSS system, not Tailwind.
 *
 * Usage:
 *   cn('btn', variant === 'primary' && 'btn--primary', className)
 */
import { clsx, type ClassValue } from 'clsx';

export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}
