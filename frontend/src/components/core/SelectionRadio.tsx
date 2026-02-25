/**
 * SelectionRadio
 *
 * Card-style radio button group. Each option is a clickable card showing a
 * radio indicator, label, optional badge, and optional description.
 *
 * Supports `vertical` (default) or `horizontal` layout via the `layout` prop.
 */
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
}

export function SelectionRadio({
  options,
  value,
  onChange,
  layout = 'vertical',
  disabled = false,
  className = '',
}: SelectionRadioProps) {
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
    >
      {options.map((opt) => {
        const selected = opt.value === value;
        const isDisabled = disabled;
        return (
          <div
            key={opt.value}
            className={[
              'radio-group__option',
              selected ? 'radio-group__option--selected' : '',
              isDisabled ? 'radio-group__option--disabled' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            role="radio"
            aria-checked={selected}
            aria-disabled={isDisabled}
            tabIndex={isDisabled ? -1 : 0}
            onClick={() => !isDisabled && onChange(opt.value)}
            onKeyDown={(e) => {
              if (!isDisabled && (e.key === 'Enter' || e.key === ' ')) {
                e.preventDefault();
                onChange(opt.value);
              }
            }}
          >
            {/* Radio indicator */}
            <div className="radio-group__indicator">
              {selected && <div className="radio-group__indicator-dot" />}
            </div>

            {/* Text content */}
            <div className="radio-group__content">
              <div className="radio-group__label-row">
                <span className="radio-group__label">{opt.label}</span>
                {opt.badge && (
                  <span className="radio-group__badge">{opt.badge}</span>
                )}
              </div>
              {opt.description && (
                <p className="radio-group__description">{opt.description}</p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default SelectionRadio;
