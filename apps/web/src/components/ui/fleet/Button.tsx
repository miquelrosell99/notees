/**
 * Button Component
 *
 * A unified button component that accepts text, an MDI icon, or both.
 * Provides consistent styling across the application.
 *
 * Thin fleet wrapper over the normalized catalog button
 * (src/components/ui/button.tsx — cva + Radix Slot underneath): the fleet
 * variant register (default/primary/outline/ghost/danger/danger-solid),
 * the xs–lg size scale, MDI icons, icon badges, haptics, and the loading
 * register (delayed spinner + aria-busy) are the app's and live here; every
 * visual value resolves to a token through the Tailwind config
 * (registered-mapping mode of the drift gate).
 *
 * Radius: the rounded-square shape at every size (owner ruling
 * 2026-10-20 — the view-mode switcher's shape-medium, superseding the
 * 2026-10-19 corner-full).
 *
 * Legacy hook classes: `btn` and `btn--icon-only` stay on the root so
 * feature CSS that compounds on them (calendar days, icon-picker items,
 * toolbar buttons) keeps matching; the base look now comes from the
 * utility layer (unlayered feature CSS still wins for the properties it
 * sets, so the overrides behave as before).
 *
 * Usage:
 * - Icon only: <Button icon="mdi mdi-cog" aria-label="Settings" />
 * - Text only: <Button>Click me</Button>
 * - Icon + Text: <Button icon="mdi mdi-cog">Settings</Button>
 * - Destructive action with inline confirmation: compose InlineConfirmButton.
 */
import {
  forwardRef,
  useCallback,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type ReactNode,
  type MouseEvent,
  type MouseEventHandler,
  type Ref,
} from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { Icon } from '../../../ui/Icon.js';
import { Spinner } from './Spinner.js';
import { useReducedMotion } from './overlay-hooks.js';
import { useDelayedVisible } from './useDelayedVisible.js';
import { cn } from './cn.js';
import './Button.css';

export type ButtonVariant = 'default' | 'primary' | 'outline' | 'ghost' | 'danger' | 'danger-solid';
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg';
export type ButtonHapticIntensity = 'light' | 'medium' | 'none';

const HAPTIC_DURATIONS: Record<ButtonHapticIntensity, number | undefined> = {
  light: 10,
  medium: 25,
  none: undefined,
};

export interface ButtonBadge {
  /** MDI icon path to show as a small icon badge */
  icon?: string | undefined;
  /** Numeric count to show as a count badge */
  count?: number | undefined;
  /** Badge position */
  position?: 'top-right' | 'bottom-right' | undefined;
}

/**
 * The variant register — a direct port of the fleet button registers
 * (hover = state-layer overlay, :active = pressed surface, focus ring from
 * --ring). The prop `active` (the active-toggle state) composes on top via
 * data-[active] classes in the wrapper body.
 */
const buttonVariants = cva(
  [
    "btn inline-flex items-center justify-center gap-1 whitespace-nowrap rounded-button",
    "border font-sans font-medium select-none cursor-pointer no-underline",
    "min-h-touch transition-colors duration-short ease-standard",
    "active:scale-press focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
    "disabled:opacity-50 disabled:cursor-not-allowed",
    "[&[data-expanded=true]_.btn__icon]:rotate-180",
  ].join(" "),
  {
    variants: {
      variant: {
        default: [
          "bg-surface-container border-outline-variant text-on-surface-variant",
          "hover:bg-hover-overlay hover:border-outline hover:text-on-surface",
          "active:bg-surface-container-highest active:border-outline active:text-on-surface",
        ].join(" "),
        primary: [
          "bg-primary border-primary text-on-primary",
          "hover:bg-primary-hover hover:border-primary-hover",
          "active:bg-primary-pressed active:border-primary-pressed",
        ].join(" "),
        outline: [
          "bg-transparent border-input text-on-surface-variant",
          "hover:bg-hover-overlay hover:text-on-surface",
          "active:bg-surface-container-high active:border-outline",
        ].join(" "),
        ghost: [
          "bg-transparent border-transparent text-on-surface-variant",
          "hover:bg-hover-overlay hover:border-outline-variant hover:text-on-surface",
          "active:bg-surface-container-high active:border-outline-variant active:text-on-surface",
        ].join(" "),
        danger: [
          "bg-transparent border-transparent text-error",
          "hover:bg-error-container",
          "active:bg-error-container",
        ].join(" "),
        'danger-solid': [
          "bg-error border-error text-on-error",
          "hover:bg-error-hover hover:border-error-hover",
          "active:bg-error-pressed active:border-error-pressed",
        ].join(" "),
      },
      size: {
        xs: "h-button-xs px-1 text-xs gap-1",
        sm: "h-button-sm px-2 text-sm gap-1",
        md: "h-button-md px-3 text-button gap-2",
        lg: "h-button-lg px-4 text-base gap-2",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "md",
    },
  },
);

/** The active-toggle state (the `active` prop) per variant. */
const ACTIVE_CLASSES: Record<ButtonVariant, string> = {
  default: "bg-surface-container-active border-outline-variant text-on-surface hover:bg-surface-container-active",
  primary: "bg-primary-pressed border-primary-pressed text-on-primary hover:bg-primary-pressed",
  outline: "bg-surface-container-active border-input text-on-surface hover:bg-surface-container-active",
  ghost: "bg-surface-container-active border-outline-variant text-on-surface hover:bg-surface-container-active",
  danger: "bg-error-container border-error text-error hover:bg-error-container",
  'danger-solid': "bg-error-pressed border-error-pressed text-on-error hover:bg-error-pressed",
};

const ICON_ONLY_SIZE: Record<ButtonSize, string> = {
  xs: "h-icon-only-visible-xs w-icon-only-visible-xs",
  sm: "h-icon-only-visible-sm w-icon-only-visible-sm",
  md: "h-icon-only-visible-md w-icon-only-visible-md",
  lg: "h-icon-only-visible-lg w-icon-only-visible-lg",
};

type ButtonBaseProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label' | 'children'> & {
  /** Render as a button (default) or an anchor. */
  as?: 'button' | 'a' | undefined;
  /** URL to navigate to when rendered as an anchor. */
  href?: string | undefined;
  /** Anchor target, used when as="a". */
  target?: string | undefined;
  /** Anchor rel, used when as="a". */
  rel?: string | undefined;
  /** MDI CSS class string (e.g. "mdi mdi-plus") */
  icon?: string | undefined;
  /** Explicit icon size multiplier (overrides the default for the button size) */
  iconSize?: number | undefined;
  /** Icon position relative to text */
  iconPosition?: 'left' | 'right' | undefined;
  /** Visual variant */
  variant?: ButtonVariant | undefined;
  /** Size of the button */
  size?: ButtonSize | undefined;
  /** Whether the button should take full width */
  fullWidth?: boolean | undefined;
  /** Whether the button is in an active/pressed state */
  active?: boolean | undefined;
  /** Whether the button is in a loading state (disables the button and shows a spinner). */
  loading?: boolean | undefined;
  /** Haptic feedback intensity. Light (10ms) for normal taps; medium (25ms) for destructive or confirm actions. */
  hapticIntensity?: ButtonHapticIntensity | undefined;
  /** Badges to display on the button */
  badges?: ButtonBadge[] | undefined;
};

export type ButtonProps = ButtonBaseProps & (
  | { icon?: string | undefined; children: ReactNode; 'aria-label'?: string | undefined }
  | { icon: string; children?: never; 'aria-label': string }
);

const ICON_SIZES: Record<ButtonSize, number> = {
  xs: 0.6,
  sm: 0.7,
  md: 0.85,
  lg: 1,
};

export const Button = forwardRef<HTMLButtonElement | HTMLAnchorElement, ButtonProps>(function Button(
  {
    icon,
    iconSize,
    iconPosition = 'left',
    variant = 'default',
    size = 'md',
    fullWidth = false,
    active = false,
    loading = false,
    hapticIntensity = 'light',
    children,
    className = '',
    disabled,
    badges,
    as = 'button',
    href,
    target,
    rel,
    onClick,
    type = 'button',
    ...props
  },
  ref
) {
  const prefersReducedMotion = useReducedMotion();
  // The loading-timing rule (<300ms nothing): the disabled/aria-busy state is
  // immediate, but the spinner only appears once loading has run 300ms.
  const showSpinner = useDelayedVisible(loading);

  const handleClick = useCallback((e: MouseEvent<HTMLButtonElement | HTMLAnchorElement>) => {
    // Tactile feedback on mobile — design-system haptic map.
    // Skip haptics when the user prefers reduced motion.
    const duration = HAPTIC_DURATIONS[hapticIntensity];
    if (duration && !prefersReducedMotion && typeof navigator !== 'undefined' && navigator.vibrate) {
      navigator.vibrate(duration);
    }
    (onClick as MouseEventHandler<HTMLButtonElement | HTMLAnchorElement> | undefined)?.(e);
  }, [onClick, hapticIntensity, prefersReducedMotion]);

  const hasText = !!children;
  const isIconOnly = icon && !hasText;

  const hasBadges = badges && badges.length > 0;

  const isDisabled = disabled || loading;

  const classNames = cn(
    buttonVariants({ variant, size }),
    isIconOnly && ["btn--icon-only", "p-0 relative", ICON_ONLY_SIZE[size]],
    fullWidth && "w-full",
    active && ACTIVE_CLASSES[variant],
    isDisabled && "opacity-50 cursor-not-allowed",
    // A loading button is working, not greyed out — keep full opacity.
    loading && "opacity-100",
    hasBadges && "relative",
    className,
  );

  const resolvedIconSize = iconSize ?? ICON_SIZES[size];

  const spinnerSize = size === 'xs' || size === 'sm' ? 'sm' : 'md';

  const content = (
    <>
      {showSpinner ? (
        <Spinner size={spinnerSize} className="btn__icon btn__icon--left shrink-0" />
      ) : (
        icon && iconPosition === 'left' && (
          <Icon path={icon} size={resolvedIconSize} className="btn__icon btn__icon--left shrink-0" />
        )
      )}
      {hasText && <span className="btn__text min-w-0 overflow-hidden text-ellipsis inline-flex items-center">{children}</span>}
      {!showSpinner && icon && iconPosition === 'right' && (
        <Icon path={icon} size={resolvedIconSize} className="btn__icon btn__icon--right shrink-0" />
      )}
      {isIconOnly && !isDisabled && (
        // Invisible minimum hit-area overlay (M3's 48dp floor) — the
        // contract the old .btn--icon-only::after carried, as a real
        // element so it needs no stylesheet.
        <span
          aria-hidden="true"
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 min-w-touch min-h-touch"
        />
      )}
      {hasBadges && badges.map((badge, i) => {
        const pos = badge.position ?? (badge.icon ? 'bottom-right' : 'top-right');
        const positionClasses =
          pos === 'top-right' ? "-top-1 -right-1" : "-bottom-1 -right-1";
        if (badge.icon) {
          return (
            <span
              key={i}
              className={cn(
                "absolute flex items-center justify-center pointer-events-none z-1",
                "h-icon-xs w-icon-xs rounded-full text-on-primary opacity-70",
                positionClasses,
              )}
              style={{ background: "color-mix(in srgb, var(--md-sys-color-primary) 50%, transparent)" }}
            >
              <Icon path={badge.icon} size={0.4} />
            </span>
          );
        }
        if (badge.count != null && badge.count > 0) {
          return (
            <span
              key={i}
              className={cn(
                "absolute flex items-center justify-center pointer-events-none z-1",
                "min-w-4 h-icon-sm px-1 rounded-full text-on-primary text-xs font-semibold leading-none opacity-70",
                positionClasses,
              )}
              style={{ background: "color-mix(in srgb, var(--md-sys-color-primary) 50%, transparent)" }}
            >
              {badge.count > 99 ? '99+' : badge.count}
            </span>
          );
        }
        return null;
      })}
    </>
  );

  if (as === 'a') {
    const anchorDisabled = disabled || loading;
    return (
      <a
        ref={ref as Ref<HTMLAnchorElement>}
        href={anchorDisabled ? undefined : href}
        target={target}
        rel={rel}
        className={classNames}
        onClick={anchorDisabled ? undefined : handleClick}
        aria-disabled={anchorDisabled || undefined}
        aria-busy={loading || undefined}
        {...(props as HTMLAttributes<HTMLAnchorElement>)}
      >
        {content}
      </a>
    );
  }

  return (
    <button
      ref={ref as Ref<HTMLButtonElement>}
      type={type}
      className={classNames}
      disabled={isDisabled}
      onClick={handleClick}
      aria-busy={loading || undefined}
      {...props}
    >
      {content}
    </button>
  );
});
