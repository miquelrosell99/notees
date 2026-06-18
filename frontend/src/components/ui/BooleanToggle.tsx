/**
 * BooleanToggle Component
 * 
 * A toggle switch component for boolean values.
 */
import { forwardRef, useId, type InputHTMLAttributes } from 'react';
import './BooleanToggle.css';
import { useReducedMotion } from '@/hooks';

export type BooleanToggleSize = 'sm' | 'md' | 'lg';

export interface BooleanToggleProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'type'> {
  /** Toggle size */
  size?: BooleanToggleSize;
  /** Label text */
  label?: string;
  /** Description text below label */
  description?: string;
  /** Label position */
  labelPosition?: 'left' | 'right';
  /** Whether to show on/off text inside the toggle */
  showOnOff?: boolean;
  /** Additional className for the container */
  className?: string;
}

/**
 * BooleanToggle (Switch) component with optional label and description.
 */
export const BooleanToggle = forwardRef<HTMLInputElement, BooleanToggleProps>(function BooleanToggle(
  {
    size = 'md',
    label,
    description,
    labelPosition = 'right',
    showOnOff = false,
    className = '',
    disabled,
    id,
    ...rest
  },
  ref
) {
  const generatedId = useId();
  const toggleId = id || generatedId;
  const prefersReducedMotion = useReducedMotion();

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    // Tactile feedback on mobile — switches use the light (10ms) haptic.
    // Skip haptics when the user prefers reduced motion.
    if (!prefersReducedMotion && typeof navigator !== 'undefined' && navigator.vibrate) {
      navigator.vibrate(10);
    }
    rest.onChange?.(e);
  };

  const containerClasses = [
    'toggle-container',
    `toggle-container--${size}`,
    `toggle-container--label-${labelPosition}`,
    disabled ? 'toggle-container--disabled' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  const toggleElement = (
    <div className="toggle-input-wrapper">
      <input
        ref={ref}
        type="checkbox"
        id={toggleId}
        className="toggle-input"
        disabled={disabled}
        {...rest}
        onChange={handleChange}
      />
      <span className={`toggle-track toggle-track--${size}`}>
        <span className="toggle-thumb" />
        {showOnOff && (
          <>
            <span className="toggle-on-text">ON</span>
            <span className="toggle-off-text">OFF</span>
          </>
        )}
      </span>
    </div>
  );

  const labelElement = (label || description) && (
    <div className="toggle-label-wrapper">
      {label && (
        <label htmlFor={toggleId} className="toggle-label">
          {label}
        </label>
      )}
      {description && (
        <span className="toggle-description">{description}</span>
      )}
    </div>
  );

  return (
    <div className={containerClasses}>
      {labelPosition === 'left' && labelElement}
      {toggleElement}
      {labelPosition === 'right' && labelElement}
    </div>
  );
});
