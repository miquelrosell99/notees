/**
 * Card Component
 *
 * A reusable card component that provides consistent styling for
 * floating panels, context menus, dropdowns, and containers throughout the app.
 */

import { forwardRef, type ReactNode, type HTMLAttributes } from "react";
import "./Card.css";

export type CardElevation = "none" | "low" | "medium" | "high";
export type CardVariant = "default" | "outlined" | "filled" | "transparent" | "dashed";
export type CardRadius = "sm" | "md" | "lg" | "xl" | "none" | "floating";

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
  paddingSize?: "sm" | "md" | "lg";
  /** Border radius size */
  radius?: CardRadius;
  /** Additional class name */
  className?: string;
  /** Whether the card is interactive (hover effects) */
  interactive?: boolean;
  /** Whether the card is in a selected/active state */
  selected?: boolean;
}

function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/**
 * Card component for floating UI elements like dropdowns, menus, popovers,
 * as well as container cards for content sections.
 * Provides consistent background, border, shadow, and border-radius styling.
 */
export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  {
    children,
    elevation = "none",
    variant = "default",
    padding = true,
    paddingSize = "md",
    radius = "md",
    className = "",
    interactive = false,
    selected = false,
    ...rest
  },
  ref,
) {
  const classes = cn(
    "card",
    `card--elevation-${elevation}`,
    `card--variant-${variant}`,
    radius ? `card--radius-${radius}` : "",
    padding ? `card--padded card--padding-${paddingSize}` : "",
    interactive ? "card--interactive" : "",
    selected ? "card--selected" : "",
    className,
  );

  return (
    <div ref={ref} className={classes} {...rest}>
      {children}
    </div>
  );
});
