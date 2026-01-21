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
 */
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import Icon from '@mdi/react';
import './Button.css';

export type ButtonVariant = 'default' | 'primary' | 'ghost' | 'danger';
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg';

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
    ...props
  },
  ref
) {
  const hasText = children && !iconOnly;
  const isIconOnly = icon && !hasText;
  const hasIconAndText = icon && hasText;

  const classNames = [
    'btn',
    `btn--${variant}`,
    `btn--${size}`,
    isIconOnly && 'btn--icon-only',
    hasIconAndText && 'btn--icon-text',
    fullWidth && 'btn--full-width',
    active && 'btn--active',
    disabled && 'btn--disabled',
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
      {...props}
    >
      {icon && iconPosition === 'left' && (
        <Icon path={icon} size={iconSize} className="btn__icon btn__icon--left" />
      )}
      {hasText && <span className="btn__text">{children}</span>}
      {icon && iconPosition === 'right' && (
        <Icon path={icon} size={iconSize} className="btn__icon btn__icon--right" />
      )}
    </button>
  );
});

export default Button;
