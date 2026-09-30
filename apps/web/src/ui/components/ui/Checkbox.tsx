/**
 * Checkbox Component
 *
 * A styled checkbox input component (check variant, default density —
 * the subset the metadata property editors use).
 */

import { forwardRef, useId, type InputHTMLAttributes } from "react";

import { Icon } from "../../Icon.js";
import "./Checkbox.css";

export type CheckboxSize = "sm" | "md" | "lg";

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size" | "type"> {
  /** Checkbox size */
  size?: CheckboxSize;
  /** Label text */
  label?: string;
  /** Additional className for the container */
  className?: string;
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { size = "md", label, className = "", disabled, id, checked, onChange, ...rest },
  ref,
) {
  const generatedId = useId();
  const checkboxId = id || `checkbox-${generatedId}`;

  return (
    <div
      className={`checkbox-container checkbox-container--${size} ${disabled ? "checkbox-container--disabled" : ""} ${className}`}
    >
      <div className="checkbox-input-wrapper">
        <input
          ref={ref}
          type="checkbox"
          id={checkboxId}
          className="checkbox-input"
          checked={checked}
          onChange={onChange}
          disabled={disabled}
          {...rest}
        />
        <span className={`checkbox-checkmark checkbox-checkmark--${size}`}>
          <Icon path="mdi-check" size={0.55} className="checkbox-icon" />
        </span>
      </div>
      {label && (
        <label htmlFor={checkboxId} className="checkbox-label-wrapper">
          <span className="checkbox-label">{label}</span>
        </label>
      )}
    </div>
  );
});
