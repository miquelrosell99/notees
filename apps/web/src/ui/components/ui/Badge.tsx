/**
 * Badge Component
 *
 * A small badge/label for displaying counts, status, or short text.
 */
import type { ReactNode } from 'react';
import './Badge.css';

export type BadgeVariant = 'primary' | 'secondary' | 'warning' | 'neutral';
export type BadgeSize = 'xs' | 'sm' | 'md';

export interface BadgeProps {
  children: ReactNode;
  variant?: BadgeVariant | undefined;
  size?: BadgeSize | undefined;
  className?: string | undefined;
}

export function Badge({
  children,
  variant = 'neutral',
  size = 'sm',
  className = '',
}: BadgeProps) {
  return (
    <span className={`badge badge--${variant} badge--${size} ${className}`}>
      {children}
    </span>
  );
}
