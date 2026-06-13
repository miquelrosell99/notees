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
import { cn } from '@/utils/cn';

export type ButtonVariant = 'default' | 'primary' | 'ghost' | 'danger';
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

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    icon,
    iconSize,
    iconPosition = 'left',
    variant = 'default',
    size = 'md',
    fullWidth = false,
    active = false,
    hapticIntensity = 'light',
    children,
    className = '',
    disabled,
    badges,
    onClick,
    type = 'button',
    ...props
  },
  ref
) {
  const handleClick = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    // Tactile feedback on mobile — design-system haptic map
    const duration = HAPTIC_DURATIONS[hapticIntensity];
    if (duration && typeof navigator !== 'undefined' && navigator.vibrate) {
      navigator.vibrate(duration);
    }
    onClick?.(e);
  }, [onClick, hapticIntensity]);

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
    disabled && 'btn--disabled',
    hasBadges && 'btn--has-badge',
    className,
  );

  const resolvedIconSize = iconSize ?? ICON_SIZES[size];

  return (
    <button
      ref={ref}
      type={type}
      className={classNames}
      disabled={disabled}
      onClick={handleClick}
      {...props}
    >
      {icon && iconPosition === 'left' && (
        <Icon path={icon} size={resolvedIconSize} className="btn__icon btn__icon--left" />
      )}
      {hasText && <span className="btn__text">{children}</span>}
      {icon && iconPosition === 'right' && (
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
    </button>
  );
});

