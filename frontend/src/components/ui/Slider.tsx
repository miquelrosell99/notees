/**
 * Slider Component
 *
 * A styled range-input slider with optional label and value display.
 * Uses CSS custom properties from variables.css.
 *
 * Usage:
 * <Slider
 *   label="Opacity"
 *   min={0} max={1} step={0.01}
 *   value={opacity}
 *   onChange={setOpacity}
 *   showValue
 *   formatValue={(v) => `${Math.round(v * 100)}%`}
 * />
 */
import { useCallback, useId, type InputHTMLAttributes } from 'react';
import './Slider.css';

export type SliderSize = 'sm' | 'md';

export interface SliderProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'size' | 'type'> {
  /** Current value */
  value: number;
  /** Minimum value */
  min: number;
  /** Maximum value */
  max: number;
  /** Step increment */
  step?: number;
  /** Called with the new numeric value on change */
  onChange: (value: number) => void;
  /** Optional label rendered above the track */
  label?: string;
  /** Show the current value next to the label */
  showValue?: boolean;
  /** Custom formatter for the displayed value */
  formatValue?: (value: number) => string;
  /** Size variant */
  size?: SliderSize;
  /** Disabled state */
  disabled?: boolean;
  /** Whether to allow changing the value via mouse wheel over the slider */
  scrollToChange?: boolean;
  /** Extra class on the root element */
  className?: string;
}

export function Slider({
  value,
  min,
  max,
  step = 0.01,
  onChange,
  label,
  showValue = false,
  formatValue,
  size = 'md',
  disabled = false,
  scrollToChange = false,
  className = '',
  style,
  ...rest
}: SliderProps) {
  const id = useId();

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onChange(parseFloat(e.target.value));
    },
    [onChange],
  );

  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      if (!scrollToChange || disabled) return;
      e.preventDefault();
      const delta = e.deltaY > 0 ? -step : step;
      const newValue = Math.max(min, Math.min(max, parseFloat((value + delta).toFixed(10))));
      onChange(newValue);
    },
    [scrollToChange, disabled, step, value, min, max, onChange]
  );

  /** Fraction of the current value within the [min, max] range (0–1) */
  const fraction = max === min ? 0 : Math.max(0, Math.min(1, (value - min) / (max - min)));
  const filledPct = `${fraction * 100}%`;

  const displayValue = formatValue ? formatValue(value) : String(value);

  const rootClass = [
    'slider',
    `slider--${size}`,
    disabled && 'slider--disabled',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={rootClass} style={style} onWheel={handleWheel}>
      {(label || showValue) && (
        <div className="slider__header">
          {label && (
            <label className="slider__label" htmlFor={id}>
              {label}
            </label>
          )}
          {showValue && <span className="slider__value">{displayValue}</span>}
        </div>
      )}

      <div className="slider__track-wrapper">
        {/* Background track */}
        <div className="slider__bg" />
        {/* Filled portion */}
        <div className="slider__filled" style={{ width: filledPct }} />
        {/* Native range input (on top for interaction) */}
        <input
          {...rest}
          id={id}
          type="range"
          className="slider__input"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          onChange={handleChange}
          aria-label={label}
        />
      </div>
    </div>
  );
}

