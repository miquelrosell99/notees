/**
 * SearchField — Rounded search input with left icon.
 *
 * A presentational input component styled as a search bar (rounded corners,
 * tinted background, left-side icon). Does NOT include dropdown/results —
 * that's the caller's job. Used by SearchBox and NodeSelector.
 */
import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from 'react';
import { Icon } from '../../Icon.js';
import './SearchField.css';

export interface SearchFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  /** Icon rendered on the left (defaults to a search icon) */
  icon?: ReactNode;
  /** Visible label text (also used as accessible name when visible) */
  label?: string;
  /** Additional CSS class on the wrapper */
  className?: string;
  /** Clear affordance: with a non-empty `value`, an × renders inside the
   * right edge and calls this (the host clears its state). */
  onClear?: (() => void) | undefined;
}

export const SearchField = forwardRef<HTMLInputElement, SearchFieldProps>(
  function SearchField({ icon, label, className = '', 'aria-label': ariaLabel, onClear, ...inputProps }, ref) {
    const id = useId();
    const hasValue = typeof inputProps.value === 'string' && inputProps.value !== '';

    const input = (
      <div className={`search-field ${className}`}>
        <span className="search-field__icon">
          {icon ?? <Icon path="mdi mdi-magnify" size="sm" />}
        </span>
        <input
          ref={ref}
          id={id}
          type="text"
          className="search-field__input"
          aria-label={ariaLabel ?? label}
          {...inputProps}
        />
        {hasValue && onClear !== undefined && (
          <button
            type="button"
            className="search-field__clear"
            aria-label="Clear search"
            title="Clear search"
            onClick={onClear}
          >
            <Icon path="mdi mdi-close" size="sm" />
          </button>
        )}
      </div>
    );

    if (label) {
      return (
        <div className="search-field-wrapper">
          <label htmlFor={id} className="search-field__label">{label}</label>
          {input}
        </div>
      );
    }

    return input;
  },
);
