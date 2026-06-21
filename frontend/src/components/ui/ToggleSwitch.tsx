/**
 * ToggleSwitch Component
 * 
 * A toggle switch with labels on each side. Unlike BooleanToggle which is
 * a simple on/off switch, ToggleSwitch shows text labels on left and right
 * sides, making it ideal for A/B choices like AND/OR or Blocks/SQL.
 */
import { forwardRef, type HTMLAttributes } from 'react';
import './ToggleSwitch.css';
import { cn } from '@/utils/cn';

export type ToggleSwitchSize = 'sm' | 'md' | 'lg';

export interface ToggleSwitchProps extends Omit<HTMLAttributes<HTMLButtonElement>, 'onChange'> {
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
export const ToggleSwitch = forwardRef<HTMLButtonElement, ToggleSwitchProps>(function ToggleSwitch(
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
  const containerClasses = cn(
    'toggle-switch',
    `toggle-switch--${size}`,
    checked ? 'toggle-switch--checked' : '',
    disabled ? 'toggle-switch--disabled' : '',
    className,
  );

  const leftId = `${props.id ?? 'toggle'}-left`;
  const rightId = `${props.id ?? 'toggle'}-right`;

  const handleClick = () => {
    if (!disabled) {
      onChange(!checked);
    }
  };

  return (
    <button
      ref={ref}
      type="button"
      className={containerClasses}
      onClick={handleClick}
      disabled={disabled}
      role="switch"
      aria-checked={checked}
      aria-disabled={disabled}
      aria-labelledby={`${leftId} ${rightId}`}
      {...props}
    >
      <span
        id={leftId}
        className={`toggle-switch__label toggle-switch__label--left ${!checked ? 'toggle-switch__label--active' : ''}`}
      >
        {leftLabel}
      </span>
      <span className="toggle-switch__track">
        <span className="toggle-switch__thumb" />
      </span>
      <span
        id={rightId}
        className={`toggle-switch__label toggle-switch__label--right ${checked ? 'toggle-switch__label--active' : ''}`}
      >
        {rightLabel}
      </span>
    </button>
  );
});

