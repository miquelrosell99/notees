/**
 * SelectionRadio
 *
 * Card-style radio button group. Each option is a clickable card showing a
 * radio indicator, label, optional badge, and optional description.
 *
 * Supports `vertical` (default) or `horizontal` layout via the `layout` prop.
 */
import React from 'react';
import './SelectionRadio.css';

export interface RadioOption {
  value: string;
  label: string;
  /** Short subtitle below the label */
  description?: string;
  /** Small pill shown next to the label (e.g. "file" or "text") */
  badge?: string;
}

interface SelectionRadioProps {
  options: RadioOption[];
  value: string;
  onChange: (value: string) => void;
  /** Stack options vertically or side-by-side. Defaults to 'vertical'. */
  layout?: 'vertical' | 'horizontal';
  disabled?: boolean;
  className?: string;
  /** Accessible label for the radio group */
  label?: string;
}

export function SelectionRadio({
  options,
  value,
  onChange,
  layout = 'vertical',
  disabled = false,
  className = '',
  label,
}: SelectionRadioProps) {
  const groupName = React.useId();
  return (
    <div
      className={[
        'radio-group',
        `radio-group--${layout}`,
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      role="radiogroup"
      aria-label={label}
    >
      {options.map((opt) => {
        const selected = opt.value === value;
        const isDisabled = disabled;
        const inputId = `${groupName}-${opt.value}`;
        return (
          <label
            key={opt.value}
            htmlFor={inputId}
            className={[
              'radio-group__option',
              selected ? 'radio-group__option--selected' : '',
              isDisabled ? 'radio-group__option--disabled' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            aria-disabled={isDisabled}
          >
            <input
              id={inputId}
              name={groupName}
              type="radio"
              value={opt.value}
              checked={selected}
              disabled={isDisabled}
              onChange={() => onChange(opt.value)}
              className="radio-group__input"
            />
            {/* Radio indicator */}
            <span className="radio-group__indicator" aria-hidden="true">
              {selected && <span className="radio-group__indicator-dot" />}
            </span>

            {/* Text content */}
            <span className="radio-group__content">
              <span className="radio-group__label-row">
                <span className="radio-group__label">{opt.label}</span>
                {opt.badge && (
                  <span className="radio-group__badge">{opt.badge}</span>
                )}
              </span>
              {opt.description && (
                <span className="radio-group__description">{opt.description}</span>
              )}
            </span>
          </label>
        );
      })}
    </div>
  );
}

