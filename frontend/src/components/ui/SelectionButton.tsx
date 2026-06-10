/**
 * SelectionButton Component
 *
 * A button-style selector with multiple options displayed as icons.
 * Features an animated selection indicator that slides between options.
 *
 * When `maxVisibleOptions` is provided, excess options are shown in an
 * overflow dropdown accessed via a "…" toggle. The inline buttons show
 * only icons; the dropdown shows icon + label.
 */
import { forwardRef, useRef, useEffect, useState, useMemo, type HTMLAttributes } from 'react';

import './SelectionButton.css';
import { Icon } from '@/components/ui/icons';

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
  /** Max options shown inline before overflow dropdown (undefined = show all) */
  maxVisibleOptions?: number;
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
    maxVisibleOptions,
    className = '',
    ...props
  },
  ref
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [indicatorStyle, setIndicatorStyle] = useState<React.CSSProperties>({});
  const [overflowOpen, setOverflowOpen] = useState(false);

  // Split options into visible and overflow
  const { visibleOptions, overflowOptions } = useMemo(() => {
    if (!maxVisibleOptions || options.length <= maxVisibleOptions) {
      return { visibleOptions: options, overflowOptions: [] as SelectionButtonOption[] };
    }
    const visible = [...options.slice(0, maxVisibleOptions)];
    const overflow = [...options.slice(maxVisibleOptions)];
    const selectedInOverflow = overflow.findIndex((opt) => opt.value === value);
    if (selectedInOverflow !== -1) {
      const swapped = visible[visible.length - 1];
      visible[visible.length - 1] = overflow[selectedInOverflow];
      overflow[selectedInOverflow] = swapped;
    }
    return { visibleOptions: visible, overflowOptions: overflow };
  }, [options, value, maxVisibleOptions]);

  const hasOverflow = overflowOptions.length > 0;

  // Calculate indicator position based on selected visible option
  useEffect(() => {
    if (!containerRef.current) return;

    const selectedIndex = visibleOptions.findIndex((opt) => opt.value === value);
    if (selectedIndex === -1) return;

    const optionElements = containerRef.current.querySelectorAll('.selection-button__option');
    const selectedElement = optionElements[selectedIndex] as HTMLElement;

    if (selectedElement) {
      if (orientation === 'horizontal') {
        setIndicatorStyle({
          width: selectedElement.offsetWidth,
          height: selectedElement.offsetHeight,
          transform: `translateX(${selectedElement.offsetLeft - 4}px)`,
        });
      } else {
        setIndicatorStyle({
          width: selectedElement.offsetWidth,
          height: selectedElement.offsetHeight,
          transform: `translateY(${selectedElement.offsetTop - 4}px)`,
        });
      }
    }
  }, [value, visibleOptions, orientation]);

  // Close overflow on click outside or Escape
  useEffect(() => {
    if (!overflowOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOverflowOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOverflowOpen(false);
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [overflowOpen]);

  const handleOptionClick = (optionValue: string) => {
    if (!disabled && optionValue !== value) {
      onChange(optionValue);
    }
  };

  const handleOverflowOptionClick = (optionValue: string) => {
    setOverflowOpen(false);
    handleOptionClick(optionValue);
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

      {/* Visible options */}
      {visibleOptions.map((option) => {
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

      {/* Overflow toggle */}
      {hasOverflow && (
        <>
          <button
            type="button"
            className={`selection-button__overflow-toggle ${overflowOpen ? 'selection-button__overflow-toggle--open' : ''}`}
            onClick={() => setOverflowOpen((prev) => !prev)}
            disabled={disabled}
            title="More options"
            aria-haspopup="menu"
            aria-expanded={overflowOpen}
          >
            <Icon path="mdi mdi-dots-horizontal" size={iconSize} />
          </button>

          {/* Overflow dropdown */}
          {overflowOpen && (
            <div className="selection-button__overflow-dropdown" role="menu">
              {overflowOptions.map((option) => {
                const isSelected = option.value === value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="menuitem"
                    className={`selection-button__overflow-item ${isSelected ? 'selection-button__overflow-item--active' : ''}`}
                    onClick={() => handleOverflowOptionClick(option.value)}
                    disabled={disabled}
                  >
                    <Icon path={option.icon} size={0.75} />
                    <span>{option.label}</span>
                  </button>
                );
              })}
            </div>
          )}
        </>
      )}
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
