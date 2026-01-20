/**
 * Checkbox Component
 * 
 * A styled checkbox input component.
 */
import { forwardRef, type InputHTMLAttributes } from 'react';
import './Checkbox.css';

export type CheckboxSize = 'sm' | 'md' | 'lg';

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'type'> {
  /** Checkbox size */
  size?: CheckboxSize;
  /** Label text */
  label?: string;
  /** Description text below label */
  description?: string;
  /** Whether the checkbox is in an indeterminate state */
  indeterminate?: boolean;
  /** Error state */
  error?: boolean;
  /** Additional className for the container */
  className?: string;
}

/**
 * Checkbox component with optional label and description.
 */
export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  {
    size = 'md',
    label,
    description,
    indeterminate = false,
    error = false,
    className = '',
    disabled,
    id,
    ...rest
  },
  ref
) {
  const checkboxId = id || `checkbox-${Math.random().toString(36).slice(2, 9)}`;
  
  const containerClasses = [
    'checkbox-container',
    `checkbox-container--${size}`,
    error ? 'checkbox-container--error' : '',
    disabled ? 'checkbox-container--disabled' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={containerClasses}>
      <div className="checkbox-input-wrapper">
        <input
          ref={ref}
          type="checkbox"
          id={checkboxId}
          className="checkbox-input"
          disabled={disabled}
          data-indeterminate={indeterminate}
          {...rest}
        />
        <span className={`checkbox-checkmark checkbox-checkmark--${size}`}>
          {indeterminate ? (
            <svg viewBox="0 0 16 16" fill="none" className="checkbox-icon">
              <rect x="3" y="7" width="10" height="2" rx="1" fill="currentColor" />
            </svg>
          ) : (
            <svg viewBox="0 0 16 16" fill="none" className="checkbox-icon">
              <path
                d="M3.5 8.5L6.5 11.5L12.5 4.5"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          )}
        </span>
      </div>
      {(label || description) && (
        <div className="checkbox-label-wrapper">
          {label && (
            <label htmlFor={checkboxId} className="checkbox-label">
              {label}
            </label>
          )}
          {description && (
            <span className="checkbox-description">{description}</span>
          )}
        </div>
      )}
    </div>
  );
});
