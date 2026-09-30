/**
 * SelectionButton Component
 *
 * A button-style selector with multiple options displayed as icons.
 * Features an animated selection indicator that slides between options.
 * (Minimal port: horizontal orientation, all options inline, no overflow
 * dropdown and no scroll-to-change.)
 */

import { forwardRef, useEffect, useRef, useState, type HTMLAttributes } from "react";

import { Icon } from "../../../Icon.js";
import "./SelectionButton.css";

export type SelectionButtonSize = "sm" | "md" | "lg";

export interface SelectionButtonOption {
  /** Unique identifier for the option */
  value: string;
  /** MDI icon path */
  icon: string;
  /** Accessible label */
  label: string;
}

export interface SelectionButtonProps extends Omit<HTMLAttributes<HTMLDivElement>, "onChange"> {
  /** List of options to display */
  options: SelectionButtonOption[];
  /** Currently selected value */
  value: string;
  /** Callback when selection changes */
  onChange: (value: string) => void;
  /** Size variant */
  size?: SelectionButtonSize;
  /** Disabled state */
  disabled?: boolean;
  /** ID for the radiogroup, used for label association */
  id?: string;
}

const ICON_SIZES: Record<SelectionButtonSize, number> = {
  sm: 0.7,
  md: 0.85,
  lg: 1,
};

export const SelectionButton = forwardRef<HTMLDivElement, SelectionButtonProps>(
  function SelectionButton(
    { options, value, onChange, size = "md", disabled = false, id, className = "", ...props },
    ref,
  ) {
    const containerRef = useRef<HTMLDivElement>(null);
    const [indicatorStyle, setIndicatorStyle] = useState<React.CSSProperties>({});

    // Calculate indicator position based on selected option
    useEffect(() => {
      if (!containerRef.current) return;

      const selectedIndex = options.findIndex((opt) => opt.value === value);
      if (selectedIndex === -1) return;

      const optionElements = containerRef.current.querySelectorAll(".selection-button__option");
      const selectedElement = optionElements[selectedIndex] as HTMLElement;

      if (selectedElement) {
        setIndicatorStyle({
          width: selectedElement.offsetWidth,
          height: selectedElement.offsetHeight,
          transform: `translateX(${selectedElement.offsetLeft - 4}px)`,
        });
      }
    }, [value, options]);

    const handleOptionClick = (optionValue: string) => {
      if (disabled) return;
      onChange(optionValue);
    };

    const handleOptionKeyDown = (e: React.KeyboardEvent, optionValue: string) => {
      if (disabled) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onChange(optionValue);
      }
    };

    const iconSize = ICON_SIZES[size];

    return (
      <div
        ref={(node) => {
          containerRef.current = node;
          if (typeof ref === "function") ref(node);
          else if (ref) ref.current = node;
        }}
        className={`selection-button selection-button--${size} ${disabled ? "selection-button--disabled" : ""} ${className}`}
        role="radiogroup"
        id={id}
        {...props}
      >
        <div className="selection-button__indicator" style={indicatorStyle} />

        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            className={`selection-button__option ${value === option.value ? "selection-button__option--selected" : ""}`}
            onClick={() => handleOptionClick(option.value)}
            onKeyDown={(e) => handleOptionKeyDown(e, option.value)}
            role="radio"
            aria-checked={value === option.value}
            disabled={disabled}
            title={option.label}
            aria-label={option.label}
          >
            <Icon path={option.icon} size={iconSize} />
          </button>
        ))}
      </div>
    );
  },
);
