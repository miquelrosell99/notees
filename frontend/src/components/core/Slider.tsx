/**
 * Slider Component
 * 
 * Core component for selecting values via a slider interface.
 * Supports both discrete (predefined positions) and continuous modes.
 */
import { useCallback, useMemo } from 'react';
import './Slider.css';

export interface SliderOption {
  value: string;
  label?: string;
  position?: number; // 0-100, calculated automatically if not provided
}

export interface SliderProps {
  /** Current value */
  value: string;
  /** Callback when value changes */
  onChange: (value: string) => void;
  /** Predefined options (discrete mode) */
  options?: SliderOption[];
  /** Show labels for discrete options */
  showLabels?: boolean;
  /** Minimum value (continuous mode) */
  min?: number;
  /** Maximum value (continuous mode) */
  max?: number;
  /** Step for continuous mode */
  step?: number;
  /** Size variant */
  size?: 'sm' | 'md' | 'lg';
  /** Additional class name */
  className?: string;
  /** Disabled state */
  disabled?: boolean;
}

/**
 * Slider - Select values via slider interface
 */
export function Slider({
  value,
  onChange,
  options,
  showLabels = false,
  min = 0,
  max = 100,
  step = 1,
  size = 'md',
  className = '',
  disabled = false,
}: SliderProps) {
  const isDiscrete = options && options.length > 0;
  
  // Calculate positions for discrete options
  const enrichedOptions = useMemo(() => {
    if (!options) return [];
    return options.map((opt, idx) => ({
      ...opt,
      position: opt.position ?? (idx / (options.length - 1)) * 100,
    }));
  }, [options]);
  
  // Get current numeric value for slider
  const numericValue = useMemo(() => {
    if (isDiscrete) {
      const currentOption = enrichedOptions.find(opt => opt.value === value);
      return currentOption?.position ?? 0;
    }
    return parseFloat(value);
  }, [value, isDiscrete, enrichedOptions]);
  
  // Handle slider change
  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const newNumericValue = parseFloat(e.target.value);
    
    if (isDiscrete) {
      // Find closest option
      const closest = enrichedOptions.reduce((prev, curr) => {
        const prevDiff = Math.abs((prev.position ?? 0) - newNumericValue);
        const currDiff = Math.abs((curr.position ?? 0) - newNumericValue);
        return currDiff < prevDiff ? curr : prev;
      });
      onChange(closest.value);
    } else {
      // Continuous mode - return the numeric value as string
      onChange(newNumericValue.toString());
    }
  }, [isDiscrete, enrichedOptions, onChange]);
  
  // Get range min/max
  const rangeMin = isDiscrete ? 0 : min;
  const rangeMax = isDiscrete ? 100 : max;
  
  return (
    <div 
      className={`slider slider--${size} ${className}`}
      data-discrete={isDiscrete}
      data-show-labels={showLabels}
    >
      <div className="slider__track-container">
        <input
          type="range"
          min={rangeMin}
          max={rangeMax}
          step={isDiscrete ? 0.1 : step}
          value={numericValue}
          onChange={handleChange}
          disabled={disabled}
          className="slider__input"
        />
        
        {/* Track with fill */}
        <div className="slider__track">
          <div 
            className="slider__fill"
            style={{ width: `${((numericValue - rangeMin) / (rangeMax - rangeMin)) * 100}%` }}
          />
        </div>
        
        {/* Discrete option markers */}
        {isDiscrete && enrichedOptions.map((option) => (
          <button
            key={option.value}
            className={`slider__marker ${value === option.value ? 'slider__marker--active' : ''}`}
            style={{ left: `${option.position}%` }}
            onClick={() => onChange(option.value)}
            disabled={disabled}
            type="button"
            aria-label={option.label || option.value}
          />
        ))}
      </div>
      
      {/* Labels */}
      {isDiscrete && showLabels && (
        <div className="slider__labels">
          {enrichedOptions.map((option) => (
            <span
              key={option.value}
              className={`slider__label ${value === option.value ? 'slider__label--active' : ''}`}
              style={{ left: `${option.position}%` }}
            >
              {option.label || option.value}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export default Slider;
