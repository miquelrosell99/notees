/**
 * TextField Component
 * 
 * A reusable text input component with consistent styling.
 * Features slightly rounded corners and subtle border.
 */
import { forwardRef, type InputHTMLAttributes } from 'react';
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
    ...props
  },
  ref
) {
  const inputClasses = [
    'text-field',
    `text-field--${size}`,
    error && 'text-field--error',
    disabled && 'text-field--disabled',
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

  if (label) {
    return (
      <div className={wrapperClasses}>
        <label className="text-field__label">{label}</label>
        <input
          ref={ref}
          className={inputClasses}
          disabled={disabled}
          {...props}
        />
        {error && errorMessage && (
          <span className="text-field__error">{errorMessage}</span>
        )}
      </div>
    );
  }

  return (
    <>
      <input
        ref={ref}
        className={inputClasses}
        disabled={disabled}
        {...props}
      />
      {error && errorMessage && (
        <span className="text-field__error">{errorMessage}</span>
      )}
    </>
  );
});

export default TextField;
