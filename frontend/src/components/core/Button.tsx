/**
 * Button Component
 * 
 * A unified button component that accepts text, an MDI icon, or both.
 * Provides consistent styling across the application.
 * 
 * Usage:
 * - Icon only: <Button icon={mdiCog} />
 * - Text only: <Button>Click me</Button>
 * - Icon + Text: <Button icon={mdiCog}>Settings</Button>
 * - With confirmation: <Button confirm confirmMessage="Are you sure?" onClick={...}>Delete</Button>
 */
import { forwardRef, useState, useCallback, type ButtonHTMLAttributes, type ReactNode } from 'react';
import Icon from '@mdi/react';
import './Button.css';
import { ConfirmationModal } from './ConfirmationModal';

export type ButtonVariant = 'default' | 'primary' | 'ghost' | 'danger';
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg';

export interface ButtonBadge {
  /** MDI icon path to show as a small icon badge */
  icon?: string;
  /** Numeric count to show as a count badge */
  count?: number;
  /** Badge position */
  position?: 'top-right' | 'bottom-right';
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** MDI icon path (from @mdi/js) */
  icon?: string;
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
  /** Whether to show only the icon (hides children) */
  iconOnly?: boolean;
  /** Children content */
  children?: ReactNode;
  /** Whether to show a confirmation dialog before firing onClick */
  confirm?: boolean;
  /** Custom confirmation message (defaults to "Are you sure?") */
  confirmMessage?: string;
  /** Badges to display on the button */
  badges?: ButtonBadge[];
}

const ICON_SIZES: Record<ButtonSize, number> = {
  xs: 0.6,
  sm: 0.7,
  md: 0.85,
  lg: 1,
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    icon,
    iconPosition = 'left',
    variant = 'default',
    size = 'md',
    fullWidth = false,
    active = false,
    iconOnly = false,
    children,
    className = '',
    disabled,
    confirm: requiresConfirm = false,
    confirmMessage,
    badges,
    onClick,
    ...props
  },
  ref
) {
  const [confirmOpen, setConfirmOpen] = useState(false);

  const handleClick = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    if (requiresConfirm) {
      e.preventDefault();
      e.stopPropagation();
      setConfirmOpen(true);
    } else {
      onClick?.(e);
    }
  }, [requiresConfirm, onClick]);

  const handleConfirm = useCallback(() => {
    setConfirmOpen(false);
    // Synthesize a click event so onClick receives a proper event
    onClick?.({} as React.MouseEvent<HTMLButtonElement>);
  }, [onClick]);

  const handleCancel = useCallback(() => {
    setConfirmOpen(false);
  }, []);

  const hasText = children && !iconOnly;
  const isIconOnly = icon && !hasText;
  const hasIconAndText = icon && hasText;

  const hasBadges = badges && badges.length > 0;

  const classNames = [
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
  ]
    .filter(Boolean)
    .join(' ');

  const iconSize = ICON_SIZES[size];

  return (
    <button
      ref={ref}
      className={classNames}
      disabled={disabled}
      onClick={handleClick}
      {...props}
    >
      {icon && iconPosition === 'left' && (
        <Icon path={icon} size={iconSize} className="btn__icon btn__icon--left" />
      )}
      {hasText && <span className="btn__text">{children}</span>}
      {icon && iconPosition === 'right' && (
        <Icon path={icon} size={iconSize} className="btn__icon btn__icon--right" />
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
      {requiresConfirm && (
        <ConfirmationModal
          isOpen={confirmOpen}
          title="Confirm action"
          message={confirmMessage ?? 'Are you sure?'}
          onConfirm={handleConfirm}
          onCancel={handleCancel}
        />
      )}
    </button>
  );
});

export default Button;
