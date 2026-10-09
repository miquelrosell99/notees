/**
 * Radio Component
 *
 * A styled radio input component — the check variant's single-selection
 * sibling: same density, same tokens, a dot instead of the checkmark. Radio
 * GROUPS compose by sharing a `name` (native semantics — arrow-key focus
 * roving and single selection come free).
 */

import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from "react";

import "./Radio.css";

export type RadioSize = "sm" | "md" | "lg";

export interface RadioProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size" | "type" | "label"> {
  /** Radio size */
  size?: RadioSize;
  /** Label content (text or an icon+text composition) */
  label?: ReactNode;
  /** Additional className for the container */
  className?: string;
}

export const Radio = forwardRef<HTMLInputElement, RadioProps>(function Radio(
  { size = "md", label, className = "", disabled, id, ...rest },
  ref,
) {
  const generatedId = useId();
  const radioId = id || `radio-${generatedId}`;

  return (
    <div
      className={`radio-container radio-container--${size} ${disabled ? "radio-container--disabled" : ""} ${className}`}
    >
      <div className="radio-input-wrapper">
        <input
          ref={ref}
          type="radio"
          id={radioId}
          className="radio-input"
          disabled={disabled}
          {...rest}
        />
        <span className={`radio-dot radio-dot--${size}`}>
          <span className="radio-dot-inner" />
        </span>
      </div>
      {label && (
        <label htmlFor={radioId} className="radio-label-wrapper">
          <span className="radio-label">{label}</span>
        </label>
      )}
    </div>
  );
});
