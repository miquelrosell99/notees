/**
 * TextField Component
 *
 * A reusable text input component with consistent styling.
 * Features slightly rounded corners and subtle border.
 */
import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from 'react';
import './TextField.css';

export type TextFieldSize = 'sm' | 'md' | 'lg';

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  /** Size variant */
  size?: TextFieldSize;
  /** Error state */
  error?: boolean;
  /** Error message */
  errorMessage?: string;
  /** Label text */
  label?: string;
  /** Additional wrapper className */
  wrapperClassName?: string;
  /** Optional icon to show on the right with a divider */
  icon?: ReactNode;
  /** Additional className for the container */
  containerClassName?: string;
}

/**
 * TextField component for text input with consistent styling.
 * Provides slightly rounded corners and subtle border styling.
 */
export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  {
    size = 'md',
    error = false,
    errorMessage,
    label,
    wrapperClassName = '',
    className = '',
    disabled,
    icon,
    containerClassName = '',
    ...props
  },
  ref
) {
  const errorId = useId();

  const inputClasses = [
    'text-field',
    `text-field--${size}`,
    error && 'text-field--error',
    disabled && 'text-field--disabled',
    icon && 'text-field--with-icon',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  const wrapperClasses = [
    'text-field-wrapper',
    wrapperClassName,
  ]
    .filter(Boolean)
    .join(' ');

  const containerClasses = [
    'text-field__container',
    error && 'text-field__container--error',
    disabled && 'text-field__container--disabled',
    containerClassName,
  ]
    .filter(Boolean)
    .join(' ');

  const inputElement = icon ? (
    <div className={containerClasses}>
      <input
        ref={ref}
        className={inputClasses}
        disabled={disabled}
        aria-invalid={error || undefined}
        aria-describedby={error && errorMessage ? errorId : undefined}
        {...props}
      />
      {icon && (
        <>
          <div className="text-field__divider" />
          <div className="text-field__icon">{icon}</div>
        </>
      )}
    </div>
  ) : (
    <input
      ref={ref}
      className={inputClasses}
      disabled={disabled}
      aria-invalid={error || undefined}
      aria-describedby={error && errorMessage ? errorId : undefined}
      {...props}
    />
  );

  if (label) {
    return (
      <div className={wrapperClasses}>
        <label htmlFor={props.id} className="text-field__label">{label}</label>
        {inputElement}
        {error && errorMessage && (
          <span id={errorId} className="text-field__error" role="alert">{errorMessage}</span>
        )}
      </div>
    );
  }

  return (
    <>
      {inputElement}
      {error && errorMessage && (
        <span id={errorId} className="text-field__error" role="alert">{errorMessage}</span>
      )}
    </>
  );
});
