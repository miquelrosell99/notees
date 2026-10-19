/**
 * Separator Component
 *
 * A visual separator that can be horizontal or vertical.
 * Used to divide sections in menus, toolbars, and other UI elements.
 *
 * Thin fleet wrapper over the normalized catalog separator
 * (src/components/ui/separator.tsx — Radix underneath): the fleet
 * thickness (size sm/md/lg) and spacing registers are the app's and live
 * here as classes; every value resolves to a token through the Tailwind
 * config (1px rides the structural h-px/w-px, md = --border-width-thick,
 * lg = --border-width-extra-thick, margins ride the spacing scale).
 *
 * Legacy hook classes: `separator` and the orientation/size/spacing
 * variants stay on the root so feature CSS that compounds on them keeps
 * matching.
 */
import { Separator as CatalogSeparator } from '@/components/ui/separator.js';
import { cn } from './cn.js';

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
