/**
 * Separator Component
 *
 * A visual separator that can be horizontal or vertical.
 * Used to divide sections in menus, toolbars, and other UI elements.
 */
import './Separator.css';

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
  const classes = [
    'separator',
    `separator--${orientation}`,
    `separator--size-${size}`,
    spacing !== 'none' ? `separator--spacing-${spacing}` : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={classes}
      role={decorative ? 'none' : 'separator'}
      aria-orientation={decorative ? undefined : orientation}
    />
  );
}
