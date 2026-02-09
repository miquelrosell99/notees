/**
 * Card Component
 * 
 * A reusable card component that provides consistent styling for
 * floating panels, context menus, dropdowns, and containers throughout the app.
 * 
 * Previously named "Panel" - renamed to "Card" for better semantic meaning.
 */
import { forwardRef, type ReactNode, type HTMLAttributes } from 'react';
import { mdiClose } from '@mdi/js';
import { Button } from './Button';
import './Card.css';

export type CardElevation = 'none' | 'low' | 'medium' | 'high';
export type CardVariant = 'default' | 'outlined' | 'filled' | 'transparent' | 'dashed';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** Card content */
  children: ReactNode;
  /** Elevation level for shadow depth */
  elevation?: CardElevation;
  /** Visual variant */
  variant?: CardVariant;
  /** Whether the card has padding */
  padding?: boolean;
  /** Padding size */
  paddingSize?: 'sm' | 'md' | 'lg';
  /** Border radius size */
  radius?: 'sm' | 'md' | 'lg' | 'none';
  /** Additional class name */
  className?: string;
  /** Whether the card is interactive (hover effects) */
  interactive?: boolean;
  /** Whether the card is in a selected/active state */
  selected?: boolean;
  /** Show close button in top-right corner */
  showCloseButton?: boolean;
  /** Callback when close button is clicked */
  onClose?: () => void;
}

/**
 * Card component for floating UI elements like dropdowns, menus, popovers,
 * as well as container cards for content sections.
 * Provides consistent background, border, shadow, and border-radius styling.
 */
export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  {
    children,
    elevation = 'medium',
    variant = 'default',
    padding = true,
    paddingSize = 'md',
    radius = 'md',
    className = '',
    interactive = false,
    selected = false,
    showCloseButton = false,
    onClose,
    ...rest
  },
  ref
) {
  const classes = [
    'card',
    `card--elevation-${elevation}`,
    `card--variant-${variant}`,
    `card--radius-${radius}`,
    padding ? `card--padded card--padding-${paddingSize}` : '',
    interactive ? 'card--interactive' : '',
    selected ? 'card--selected' : '',
    showCloseButton ? 'card--has-close' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div ref={ref} className={classes} {...rest}>
      {showCloseButton && (
        <Button
          icon={mdiClose}
          iconOnly
          className="card__close-btn"
          onClick={onClose}
          size="sm"
          variant="ghost"
        />
      )}
      {children}
    </div>
  );
});

