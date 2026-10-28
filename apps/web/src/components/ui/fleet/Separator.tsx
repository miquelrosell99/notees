/**
 * Separator Component
 *
 * A visual separator that can be horizontal or vertical.
 * Used to divide sections in menus, toolbars, and other UI elements.
 *
 * Self-contained fleet separator: the Radix separator composition
 * (absorbed from the retired src/components/ui/separator.tsx layer — the
 * Root with the orientation/decorative handling, private CatalogSeparator
 * below) now lives here; the fleet thickness (size sm/md/lg) and spacing
 * registers are the app's and live here as classes; every value resolves
 * to a token through the Tailwind config (1px rides the structural
 * h-px/w-px, md = --border-width-thick, lg = --border-width-extra-thick,
 * margins ride the spacing scale).
 *
 * Legacy hook classes: `separator` and the orientation/size/spacing
 * variants stay on the root so feature CSS that compounds on them keeps
 * matching.
 */
import { forwardRef, type ElementRef, type ComponentPropsWithoutRef } from 'react';
import * as SeparatorPrimitive from '@radix-ui/react-separator';

import { cn } from './cn.js';

/**
 * The catalog-separator composition (absorbed from the retired
 * src/components/ui/separator.tsx layer): Radix Root with the
 * orientation/decorative defaults, the normalized token register.
 * Private to this file.
 */
const CatalogSeparator = forwardRef<
  ElementRef<typeof SeparatorPrimitive.Root>,
  ComponentPropsWithoutRef<typeof SeparatorPrimitive.Root>
>(
  (
    { className, orientation = "horizontal", decorative = true, ...props },
    ref,
  ) => (
    <SeparatorPrimitive.Root
      ref={ref}
      decorative={decorative}
      orientation={orientation}
      className={cn(
        "shrink-0 bg-border",
        orientation === "horizontal" ? "h-px w-full" : "h-full w-px",
        className,
      )}
      {...props}
    />
  ),
);
CatalogSeparator.displayName = 'Separator';

export type SeparatorOrientation = 'horizontal' | 'vertical';
export type SeparatorSize = 'sm' | 'md' | 'lg';

export interface SeparatorProps {
  /** Orientation of the separator */
  orientation?: SeparatorOrientation | undefined;
  /** Size (thickness) of the separator */
  size?: SeparatorSize | undefined;
  /** Additional margin around the separator */
  spacing?: SeparatorSize | 'none' | undefined;
  /** Custom className */
  className?: string | undefined;
  /** Whether the separator is decorative (not semantic) */
  decorative?: boolean | undefined;
}

/**
 * Separator component for visually dividing content.
 */
export function Separator({
  orientation = 'horizontal',
  size = 'sm',
  spacing = 'sm',
  className = '',
  decorative = true,
}: SeparatorProps) {
  // Full literal classes — Tailwind's scanner only generates complete
  // class strings, so no interpolation here.
  const thickness = {
    horizontal: {
      sm: 'h-px w-full',
      md: 'h-sep-md w-full',
      lg: 'h-sep-lg w-full',
    },
    vertical: {
      sm: 'h-full w-px self-stretch',
      md: 'h-full w-sep-md self-stretch',
      lg: 'h-full w-sep-lg self-stretch',
    },
  }[orientation][size];

  const margin = {
    horizontal: {
      none: '',
      sm: 'my-1',
      md: 'my-2',
      lg: 'my-3',
    },
    vertical: {
      none: '',
      sm: 'mx-1',
      md: 'mx-2',
      lg: 'mx-3',
    },
  }[orientation][spacing];

  return (
    <CatalogSeparator
      decorative={decorative}
      orientation={orientation}
      className={cn(
        'separator shrink-0 bg-outline-variant',
        thickness,
        margin,
        className,
      )}
    />
  );
}
