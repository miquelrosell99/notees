/**
 * FloatingButtonArray Component
 * 
 * Displays a collection of buttons inside a Card with consistent spacing.
 * Designed for floating action buttons on images and assets.
 */
import { type ReactNode } from 'react';
import { Card } from './Card';
import './FloatingButtonArray.css';

// ─── ToolbarDivider ────────────────────────────────────────────────

export interface ToolbarDividerProps {
  /** Visual orientation of the divider line.
   * - 'vertical'   → thin vertical bar (for horizontal toolbars)
   * - 'horizontal' → thin horizontal bar (for vertical toolbars)
   * Defaults to 'vertical'. */
  orientation?: 'horizontal' | 'vertical';
}

/**
 * ToolbarDivider — a lightweight separator for use inside FloatingButtonArray.
 *
 * Drop it between groups of toolbar buttons to visually divide them.
 * The orientation mirrors the direction of the surrounding toolbar:
 * use 'vertical' (default) inside a horizontal toolbar row.
 */
export function ToolbarDivider({ orientation = 'vertical' }: ToolbarDividerProps) {
  return (
    <div
      className={`toolbar-divider toolbar-divider--${orientation}`}
      role="separator"
      aria-orientation={orientation}
    />
  );
}

export interface FloatingButtonArrayProps {
  /** Button elements to display */
  children: ReactNode;
  /** Custom class name */
  className?: string;
  /** Direction of button layout */
  direction?: 'horizontal' | 'vertical';
  /** Size variant affecting spacing */
  size?: 'xs' | 'sm' | 'md';
}

/**
 * FloatingButtonArray - Displays buttons in a Card with consistent spacing
 */
export function FloatingButtonArray({
  children,
  className = '',
  direction = 'horizontal',
  size = 'md',
}: FloatingButtonArrayProps) {
  return (
    <Card
      className={`floating-button-array floating-button-array--${direction} floating-button-array--${size} ${className}`}
      elevation="low"
      variant="filled"
      padding={false}
      radius="floating"
    >
      <div className="floating-button-array__inner">
        {children}
      </div>
    </Card>
  );
}
