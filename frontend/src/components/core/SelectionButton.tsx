/**
 * SelectionButton Component
 * 
 * A button-style selector with multiple options displayed as icons.
 * Features an animated selection indicator that slides between options.
 */
import { forwardRef, useRef, useEffect, useState, type HTMLAttributes } from 'react';
import Icon from '@mdi/react';
import './SelectionButton.css';

export type SelectionButtonSize = 'sm' | 'md' | 'lg';
export type SelectionButtonOrientation = 'horizontal' | 'vertical';

export interface SelectionButtonOption {
  /** Unique identifier for the option */
  value: string;
  /** MDI icon path */
  icon: string;
  /** Accessible label */
  label: string;
}

export interface SelectionButtonProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onChange'> {
  /** List of options to display */
  options: SelectionButtonOption[];
  /** Currently selected value */
  value: string;
  /** Callback when selection changes */
  onChange: (value: string) => void;
  /** Display orientation */
  orientation?: SelectionButtonOrientation;
  /** Size variant */
  size?: SelectionButtonSize;
  /** Disabled state */
  disabled?: boolean;
  /** Label text */
  label?: string;
  /** Description text below label */
  description?: string;
  /** Label position */
  labelPosition?: 'left' | 'right';
}

const ICON_SIZES: Record<SelectionButtonSize, number> = {
  sm: 0.7,
  md: 0.85,
  lg: 1,
};

export const SelectionButton = forwardRef<HTMLDivElement, SelectionButtonProps>(function SelectionButton(
  {
    options,
    value,
    onChange,
    orientation = 'horizontal',
    size = 'md',
    disabled = false,
    label,
    description,
    labelPosition = 'right',
    className = '',
    ...props
  },
  ref
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [indicatorStyle, setIndicatorStyle] = useState<React.CSSProperties>({});
  
  // Calculate indicator position based on selected option
  useEffect(() => {
    if (!containerRef.current) return;
    
    const selectedIndex = options.findIndex(opt => opt.value === value);
    if (selectedIndex === -1) return;
    
    const optionElements = containerRef.current.querySelectorAll('.selection-button__option');
    const selectedElement = optionElements[selectedIndex] as HTMLElement;
    
    if (selectedElement) {
      // Use offsetLeft/offsetTop which are relative to the offsetParent (container)
      // and already account for padding correctly
      if (orientation === 'horizontal') {
        setIndicatorStyle({
          width: selectedElement.offsetWidth,
          height: selectedElement.offsetHeight,
          transform: `translateX(${selectedElement.offsetLeft - 4}px)`, // Subtract padding
        });
      } else {
        setIndicatorStyle({
          width: selectedElement.offsetWidth,
          height: selectedElement.offsetHeight,
          transform: `translateY(${selectedElement.offsetTop - 4}px)`, // Subtract padding
        });
      }
    }
  }, [value, options, orientation]);

  const handleOptionClick = (optionValue: string) => {
    if (!disabled && optionValue !== value) {
      onChange(optionValue);
    }
  };

  const containerClasses = [
    'selection-button',
    `selection-button--${orientation}`,
    `selection-button--${size}`,
    disabled && 'selection-button--disabled',
  ]
    .filter(Boolean)
    .join(' ');

  const iconSize = ICON_SIZES[size];

  const hasLabel = label || description;

  const buttonElement = (
    <div
      ref={(node) => {
        if (!hasLabel) {
          if (typeof ref === 'function') ref(node);
          else if (ref) ref.current = node;
        }
        (containerRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
      }}
      className={containerClasses}
      role="radiogroup"
    >
      {/* Animated selection indicator */}
      <span 
        className="selection-button__indicator" 
        style={indicatorStyle}
        aria-hidden="true"
      />
      
      {/* Options */}
      {options.map((option) => {
        const isSelected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={isSelected}
            aria-label={option.label}
            title={option.label}
            className={`selection-button__option ${isSelected ? 'selection-button__option--selected' : ''}`}
            onClick={() => handleOptionClick(option.value)}
            disabled={disabled}
          >
            <Icon path={option.icon} size={iconSize} />
          </button>
        );
      })}
    </div>
  );

  if (!hasLabel) {
    return buttonElement;
  }

  const labelElement = (
    <div className="selection-button__label-wrapper">
      {label && <span className="selection-button__label">{label}</span>}
      {description && <span className="selection-button__description">{description}</span>}
    </div>
  );

  const wrapperClasses = [
    'selection-button__wrapper',
    `selection-button__wrapper--label-${labelPosition}`,
    `selection-button__wrapper--${size}`,
    disabled && 'selection-button__wrapper--disabled',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      ref={ref as React.Ref<HTMLDivElement>}
      className={wrapperClasses}
      {...props}
    >
      {labelPosition === 'left' && labelElement}
      {buttonElement}
      {labelPosition === 'right' && labelElement}
    </div>
  );
});

export default SelectionButton;
