/**
 * Card Component
 *
 * A reusable card component that provides consistent styling for
 * floating panels, context menus, dropdowns, and containers throughout the app.
 *
 * Local stand-in for the app-level Card: identical DOM output and class
 * contract, minus the mobile-layout context consumer (the `mobileLayout`
 * prop remains for explicit control).
 */
import { forwardRef, type ReactNode, type HTMLAttributes } from 'react';
import './Card.css';
import { cn } from './cn';

export type CardElevation = 'none' | 'low' | 'medium' | 'high';
export type CardVariant = 'default' | 'outlined' | 'filled' | 'transparent' | 'dashed';
export type CardRadius = 'sm' | 'md' | 'lg' | 'xl' | 'none' | 'floating';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** Card content */
  children: ReactNode;
  /** Elevation level for shadow depth */
  elevation?: CardElevation | undefined;
  /** Visual variant */
  variant?: CardVariant | undefined;
  /** Whether the card has padding */
  padding?: boolean | undefined;
  /** Padding size */
  paddingSize?: 'sm' | 'md' | 'lg' | undefined;
  /** Border radius size */
  radius?: CardRadius | undefined;
  /** Additional class name */
  className?: string | undefined;
  /** Whether the card is interactive (hover effects) */
  interactive?: boolean | undefined;
  /** Whether the card is in a selected/active state */
  selected?: boolean | undefined;
  /** Show close button in top-right corner */
  showCloseButton?: boolean | undefined;
  /** Callback when close button is clicked */
  onClose?: (() => void) | undefined;
  /** Render in mobile layout mode (full-bleed, no border radius). */
  mobileLayout?: boolean | undefined;
}

/**
 * Card component for floating UI elements like dropdowns, menus, popovers,
 * as well as container cards for content sections.
 * Provides consistent background, border, shadow, and border-radius styling.
 */
export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  {
    children,
    elevation = 'none',
    variant = 'default',
    padding = true,
    paddingSize = 'md',
    radius = 'md',
    className = '',
    interactive = false,
    selected = false,
    showCloseButton = false,
    onClose,
    mobileLayout = false,
    ...rest
  },
  ref
) {
  const mobileLayoutAttr = mobileLayout || undefined;

  const classes = cn(
    'card',
    `card--elevation-${elevation}`,
    `card--variant-${variant}`,
    radius ? `card--radius-${radius}` : '',
    padding ? `card--padded card--padding-${paddingSize}` : '',
    interactive ? 'card--interactive' : '',
    selected ? 'card--selected' : '',
    showCloseButton ? 'card--has-close' : '',
    className,
  );

  return (
    <div ref={ref} className={classes} data-mobile-layout={mobileLayoutAttr} {...rest}>
      {showCloseButton && (
        <button
          type="button"
          className="card__close-btn"
          onClick={onClose}
          aria-label="Close"
        >
          <span className="mdi mdi-close" aria-hidden="true" />
        </button>
      )}
      {children}
    </div>
  );
});
