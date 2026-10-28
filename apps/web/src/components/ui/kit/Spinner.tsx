/**
 * Spinner — Reusable loading indicator
 *
 * A simple CSS-animated spinner for consistent loading states
 * across the application.
 *
 * Self-contained fleet spinner: the border-arc composition (absorbed from
 * the retired src/components/ui/spinner.tsx layer — private
 * CatalogSpinner below) now lives here: the arc rides the icon-size
 * tokens, spins on the 0.8s linear register, and stays a PURELY VISUAL
 * span — the role=status/aria-busy announcement is the caller's (this
 * wrapper owns it). The sm/md/lg size scale, the optional label, and the
 * centered layout are the app's and live here. The reduced-motion honest
 * cue (the arc swaps for a "…" text marker) rides this file's co-located
 * CSS — the utility layer can't express the pseudo-element swap; that
 * block is all the CSS the spinner keeps.
 *
 * Legacy hook classes: `spinner-wrapper` / `spinner` (+ the size and
 * centered variants) stay on their elements so feature CSS and the
 * reduced-motion block keep matching.
 */
import type { ComponentProps } from 'react';

import { cn } from './cn.js';
import './Spinner.css';

/**
 * The catalog-spinner composition (absorbed from the retired
 * src/components/ui/spinner.tsx layer): the border-arc spinner (the
 * registry's lucide Loader2 original swapped) — the arc rides the
 * icon-size tokens and spins on the 0.8s linear register. Private to
 * this file.
 */
function CatalogSpinner({ className, ...props }: ComponentProps<'span'>) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block shrink-0 rounded-full border-thick border-solid border-outline-variant border-t-on-surface-variant motion-safe:animate-spinner-arc",
        className,
      )}
      {...props}
    />
  );
}

export interface SpinnerProps {
  /** Spinner size (default: md) */
  size?: 'sm' | 'md' | 'lg' | undefined;
  /** Optional label shown next to the spinner */
  label?: string | undefined;
  /** Center the spinner within its container (default: false) */
  centered?: boolean | undefined;
  /** Additional className on the wrapper */
  className?: string | undefined;
}

export function Spinner({ size = 'md', label, centered = false, className = '' }: SpinnerProps) {
  return (
    <span
      className={cn(
        'spinner-wrapper',
        centered
          ? 'spinner-wrapper--centered flex w-full items-center justify-center'
          : 'inline-flex items-center justify-center gap-2',
        className,
      )}
      role="status"
      aria-busy="true"
    >
      <CatalogSpinner
        className={cn(
          'spinner',
          {
            sm: 'h-icon-sm w-icon-sm',
            md: 'h-icon-lg w-icon-lg',
            lg: 'h-icon-xl w-icon-xl border-extra-thick',
          }[size],
        )}
      />
      {label && (
        <span className="spinner-label text-on-surface-variant">{label}</span>
      )}
    </span>
  );
}
