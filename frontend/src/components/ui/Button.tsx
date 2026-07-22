/**
 * Button Component
 * 
 * A unified button component that accepts text, an MDI icon, or both.
 * Provides consistent styling across the application.
 * 
 * Usage:
 * - Icon only: <Button icon="mdi mdi-cog" aria-label="Settings" />
 * - Text only: <Button>Click me</Button>
 * - Icon + Text: <Button icon="mdi mdi-cog">Settings</Button>
 * - With confirmation: <Button confirm confirmMessage="Are you sure?" onClick={...}>Delete</Button>
 */
import { forwardRef, useCallback, type ButtonHTMLAttributes, type ReactNode } from 'react';

import './Button.css';
import { Icon } from '@/components/ui/icons';
import { Spinner } from '@/components/ui/Spinner';
import { useReducedMotion } from '@/hooks';
import { cn } from '@/utils/cn';

export type ButtonVariant = 'default' | 'primary' | 'ghost' | 'danger' | 'danger-solid';
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg';
export type ButtonHapticIntensity = 'light' | 'medium' | 'none';

const HAPTIC_DURATIONS: Record<ButtonHapticIntensity, number | undefined> = {
  light: 10,
  medium: 25,
  none: undefined,
};

export interface ButtonBadge {
  /** MDI icon path to show as a small icon badge */
  icon?: string;
  /** Numeric count to show as a count badge */
  count?: number;
  /** Badge position */
  position?: 'top-right' | 'bottom-right';
}

type ButtonBaseProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label' | 'children'> & {
  /** Render as a button (default) or an anchor. */
  as?: 'button' | 'a';
  /** URL to navigate to when rendered as an anchor. */
  href?: string;
  /** Anchor target, used when as="a". */
  target?: string;
  /** Anchor rel, used when as="a". */
  rel?: string;
  /** MDI CSS class string (e.g. "mdi mdi-plus") */
  icon?: string;
  /** Explicit icon size multiplier (overrides the default for the button size) */
  iconSize?: number;
  /** Icon position relative to text */
  iconPosition?: 'left' | 'right';
  /** Visual variant */
  variant?: ButtonVariant;
  /** Size of the button */
  size?: ButtonSize;
  /** Whether the button should take full width */
  fullWidth?: boolean;
  /** Whether the button is in an active/pressed state */
  active?: boolean;
  /** Whether the button is in a loading state (disables the button and shows a spinner). */
  loading?: boolean;
  /** Haptic feedback intensity. Light (10ms) for normal taps; medium (25ms) for destructive or confirm actions. */
  hapticIntensity?: ButtonHapticIntensity;
  /** Badges to display on the button */
  badges?: ButtonBadge[];
};

export type ButtonProps = ButtonBaseProps & (
  | { icon?: string; children: ReactNode; 'aria-label'?: string }
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

  const handleClick = useCallback((e: React.MouseEvent<HTMLButtonElement | HTMLAnchorElement>) => {
    // Tactile feedback on mobile — design-system haptic map.
    // Skip haptics when the user prefers reduced motion.
    const duration = HAPTIC_DURATIONS[hapticIntensity];
    if (duration && !prefersReducedMotion && typeof navigator !== 'undefined' && navigator.vibrate) {
      navigator.vibrate(duration);
    }
    (onClick as React.MouseEventHandler<HTMLButtonElement | HTMLAnchorElement> | undefined)?.(e);
  }, [onClick, hapticIntensity, prefersReducedMotion]);

  const hasText = !!children;
  const isIconOnly = icon && !hasText;
  const hasIconAndText = icon && hasText;

  const hasBadges = badges && badges.length > 0;

  const classNames = cn(
    'btn',
    `btn--${variant}`,
    `btn--${size}`,
    isIconOnly && 'btn--icon-only',
    hasIconAndText && 'btn--icon-text',
    fullWidth && 'btn--full-width',
    active && 'btn--active',
    (disabled || loading) && 'btn--disabled',
    loading && 'btn--loading',
    hasBadges && 'btn--has-badge',
    className,
  );

  const resolvedIconSize = iconSize ?? ICON_SIZES[size];

  const spinnerSize = size === 'xs' || size === 'sm' ? 'sm' : 'md';

  const content = (
    <>
      {loading ? (
        <Spinner size={spinnerSize} className="btn__icon btn__icon--left" />
      ) : (
        icon && iconPosition === 'left' && (
          <Icon path={icon} size={resolvedIconSize} className="btn__icon btn__icon--left" />
        )
      )}
      {hasText && <span className="btn__text">{children}</span>}
      {!loading && icon && iconPosition === 'right' && (
        <Icon path={icon} size={resolvedIconSize} className="btn__icon btn__icon--right" />
      )}
      {hasBadges && badges.map((badge, i) => {
        const pos = badge.position ?? (badge.icon ? 'bottom-right' : 'top-right');
        if (badge.icon) {
          return (
            <span key={i} className={`btn__badge btn__badge--icon btn__badge--${pos}`}>
              <Icon path={badge.icon} size={0.4} />
            </span>
          );
        }
        if (badge.count != null && badge.count > 0) {
          return (
            <span key={i} className={`btn__badge btn__badge--count btn__badge--${pos}`}>
              {badge.count > 99 ? '99+' : badge.count}
            </span>
          );
        }
        return null;
      })}
    </>
  );

  if (as === 'a') {
    return (
      <a
        ref={ref as React.Ref<HTMLAnchorElement>}
        href={href}
        target={target}
        rel={rel}
        className={classNames}
        onClick={handleClick}
        {...(props as React.HTMLAttributes<HTMLAnchorElement>)}
      >
        {content}
      </a>
    );
  }

  return (
    <button
      ref={ref as React.Ref<HTMLButtonElement>}
      type={type}
      className={classNames}
      disabled={disabled || loading}
      onClick={handleClick}
      aria-busy={loading || undefined}
      {...props}
    >
      {content}
    </button>
  );
});

