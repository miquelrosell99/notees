/**
 * Card Component
 *
 * A reusable card component that provides consistent styling for
 * floating panels, context menus, dropdowns, and containers throughout
 * the app.
 *
 * Thin fleet wrapper over the normalized catalog card
 * (src/components/ui/card.tsx): every visual value resolves to a token
 * through the Tailwind config (registered-mapping mode). The legacy `card`
 * marker class stays on the root — feature CSS (ContextMenu, Dropdown)
 * legitimately compounds on `.card` for their surface registers, and
 * unlayered feature CSS keeps winning over the utility layer, so the
 * overrides behave exactly as before.
 */
import { forwardRef, type ReactNode, type HTMLAttributes } from "react";
import { cn } from "./cn.js";

export type CardElevation = "none" | "low" | "medium" | "high";
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

const VARIANT_CLASSES: Record<CardVariant, string> = {
  default: "bg-surface border border-outline-variant",
  outlined: "bg-transparent border border-outline",
  filled: "bg-surface-variant border-0",
  transparent: "bg-transparent border-0 shadow-none",
  dashed: "bg-transparent border-thick border-dashed border-outline-variant",
};

/** The radius scale maps the app's shape tokens onto the registered family. */
const RADIUS_CLASSES: Record<CardRadius, string> = {
  none: "rounded-none",
  sm: "rounded-menu overflow-hidden",
  floating: "rounded-floating overflow-hidden",
  md: "rounded-input overflow-hidden",
  lg: "rounded-card overflow-hidden",
  xl: "rounded-sheet overflow-hidden",
};

const ELEVATION_CLASSES: Record<CardElevation, string> = {
  none: "shadow-none",
  low: "shadow-level1",
  medium: "shadow-level2",
  high: "shadow-level3",
};

const PADDING_CLASSES = {
  sm: "p-2",
  md: "p-4",
  lg: "p-6",
} as const;

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
    "card",
    VARIANT_CLASSES[variant],
    mobileLayout ? "rounded-none shadow-none" : RADIUS_CLASSES[radius],
    mobileLayout ? "shadow-none" : ELEVATION_CLASSES[elevation],
    padding && !mobileLayout && PADDING_CLASSES[paddingSize],
    interactive &&
      "cursor-pointer transition-card duration-short ease-standard hover:bg-hover-overlay hover:border-outline hover:-translate-y-hairline active:bg-pressed-overlay active:translate-y-0 active:scale-card",
    selected && "border-primary bg-primary-container",
    showCloseButton && "relative",
    variant === "dashed" &&
      "hover:border-primary hover:bg-hover-overlay focus-within:border-primary focus-within:bg-hover-overlay",
    className,
  );

  return (
    <div ref={ref} className={classes} data-mobile-layout={mobileLayoutAttr} {...rest}>
      {showCloseButton && (
        <button
          type="button"
          className="absolute top-2 right-2 z-1"
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
