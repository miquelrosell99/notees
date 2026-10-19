/**
 * Badge Component
 *
 * A small badge/label for displaying counts, status, or short text.
 *
 * Thin fleet wrapper over the normalized catalog badge
 * (src/components/ui/badge.tsx — cva underneath): the fleet variant
 * register (primary/secondary/warning/neutral) and the xs–md size scale
 * are the app's and live here as cva variants; every visual value resolves
 * to a token through the Tailwind config. The secondary register rides the
 * canonical M3 secondary-container pair (the pre-catalog bare-secondary
 * hue retired with the migration).
 *
 * Legacy hook classes: `badge` and `badge--${variant}` / `badge--${size}`
 * stay on the root so feature CSS and tests that compound on them keep
 * matching; the base look now comes from the utility layer.
 */
import type { ReactNode } from 'react';
import { cva } from 'class-variance-authority';

import { Badge as CatalogBadge } from '@/components/ui/badge';
import { cn } from './cn';

const badgeVariants = cva(
  'badge inline-flex items-center justify-center gap-1 whitespace-nowrap rounded-badge border border-transparent font-semibold transition-colors duration-short ease-standard',
  {
    variants: {
      variant: {
        primary: 'badge--primary bg-primary text-on-primary',
        secondary: 'badge--secondary bg-secondary-container text-on-secondary-container',
        warning: 'badge--warning bg-warning text-on-warning',
        neutral: 'badge--neutral bg-surface-variant text-on-surface-variant',
      },
      size: {
        xs: 'badge--xs h-xs min-w-xs px-1 text-xs',
        sm: 'badge--sm h-sm min-w-sm px-2 text-sm',
        md: 'badge--md h-md min-w-md px-2 text-base',
      },
    },
    defaultVariants: {
      variant: 'neutral',
      size: 'sm',
    },
  },
);

export type BadgeVariant = 'primary' | 'secondary' | 'warning' | 'neutral';
export type BadgeSize = 'xs' | 'sm' | 'md';

export interface BadgeProps {
  children: ReactNode;
  variant?: BadgeVariant | undefined;
  size?: BadgeSize | undefined;
  className?: string | undefined;
}

export function Badge({ children, variant = 'neutral', size = 'sm', className = '' }: BadgeProps) {
  return (
    <CatalogBadge className={cn(badgeVariants({ variant, size }), className)}>
      {children}
    </CatalogBadge>
  );
}
