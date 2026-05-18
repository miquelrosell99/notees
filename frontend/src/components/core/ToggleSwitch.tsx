/**
 * ToggleSwitch Component
 * 
 * A toggle switch with labels on each side. Unlike BooleanToggle which is
 * a simple on/off switch, ToggleSwitch shows text labels on left and right
 * sides, making it ideal for A/B choices like AND/OR or Blocks/SQL.
 */
import { forwardRef, type HTMLAttributes } from 'react';
import './ToggleSwitch.css';

export type ToggleSwitchSize = 'sm' | 'md' | 'lg';

export interface ToggleSwitchProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onChange'> {
  /** Size variant */
  size?: ToggleSwitchSize;
  /** Label for the left (unchecked) state */
  leftLabel: string;
  /** Label for the right (checked) state */
  rightLabel: string;
  /** Whether the switch is in the right (checked) position */
  checked: boolean;
  /** Callback when the switch state changes */
  onChange: (checked: boolean) => void;
  /** Whether the switch is disabled */
  disabled?: boolean;
}

/**
 * ToggleSwitch - A switch with labels on both sides for A/B selection.
 */
export const ToggleSwitch = forwardRef<HTMLDivElement, ToggleSwitchProps>(function ToggleSwitch(
  {
    size = 'md',
    leftLabel,
    rightLabel,
    checked,
    onChange,
    disabled = false,
    className = '',
    ...props
  },
  ref
) {
  const containerClasses = [
    'toggle-switch',
    `toggle-switch--${size}`,
    checked ? 'toggle-switch--checked' : '',
    disabled ? 'toggle-switch--disabled' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  const handleClick = () => {
    if (!disabled) {
      onChange(!checked);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!disabled && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      onChange(!checked);
    }
  };

  return (
    <div
      ref={ref}
      className={containerClasses}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      tabIndex={disabled ? -1 : 0}
      role="switch"
      aria-checked={checked}
      aria-disabled={disabled}
      {...props}
    >
      <span
        className={`toggle-switch__label toggle-switch__label--left ${!checked ? 'toggle-switch__label--active' : ''}`}
      >
        {leftLabel}
      </span>
      <div className="toggle-switch__track">
        <div className="toggle-switch__thumb" />
      </div>
      <span
        className={`toggle-switch__label toggle-switch__label--right ${checked ? 'toggle-switch__label--active' : ''}`}
      >
        {rightLabel}
      </span>
    </div>
  );
});

