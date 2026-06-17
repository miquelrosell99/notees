/**
 * Checkbox Component
 * 
 * A styled checkbox input component.
 */
import { forwardRef, useId, type InputHTMLAttributes } from 'react';
import './Checkbox.css';
import { cn } from '@/utils/cn';

export type CheckboxSize = 'sm' | 'md' | 'lg';
export type CheckboxVariant = 'check' | 'dot';
export type CheckboxDensity = 'default' | 'minimal';

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'type'> {
  /** Checkbox size */
  size?: CheckboxSize;
  /** Checkbox icon variant: 'check' for checkmark, 'dot' for filled circle */
  variant?: CheckboxVariant;
  /** Visual density: 'default' for the standard checkbox, 'minimal' for a smaller, thinner variant */
  density?: CheckboxDensity;
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
    variant = 'check',
    density = 'default',
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
  const generatedId = useId();
  const checkboxId = id || `checkbox-${generatedId}`;

  const containerClasses = cn(
    'checkbox-container',
    `checkbox-container--${size}`,
    `checkbox-container--${density}`,
    error ? 'checkbox-container--error' : '',
    disabled ? 'checkbox-container--disabled' : '',
    className,
  );

  // Render the appropriate icon based on state
  const renderIcon = () => {
    if (indeterminate) {
      // Indeterminate state: horizontal bar
      return (
        <svg viewBox="0 0 16 16" fill="none" className="checkbox-icon">
          <rect x="3" y="7" width="10" height="2" rx="1" fill="currentColor" />
        </svg>
      );
    }
    if (variant === 'dot') {
      // Dot variant: filled circle (for negated/excluded states)
      return (
        <svg viewBox="0 0 16 16" fill="none" className="checkbox-icon">
          <circle cx="8" cy="8" r="4" fill="currentColor" />
        </svg>
      );
    }
    // Default check variant: checkmark
    return (
      <svg viewBox="0 0 16 16" fill="none" className="checkbox-icon">
        <path
          d="M3.5 8.5L6.5 11.5L12.5 4.5"
          stroke="currentColor"
          strokeWidth={density === 'minimal' ? 1.5 : 2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  };

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
          {renderIcon()}
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
