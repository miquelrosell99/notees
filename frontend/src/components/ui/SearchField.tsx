/**
 * SearchField — Rounded search input with left icon.
 *
 * A presentational input component styled as a search bar (rounded corners,
 * tinted background, left-side icon). Does NOT include dropdown/results —
 * that's the caller's job. Used by SearchBox and NodeSelector.
 */
import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from 'react';
import { SearchIcon } from './icons';
import './SearchField.css';

export interface SearchFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  /** Icon rendered on the left (defaults to SearchIcon) */
  icon?: ReactNode;
  /** Visible label text (also used as accessible name when visible) */
  label?: string;
  /** Additional CSS class on the wrapper */
  className?: string;
}

export const SearchField = forwardRef<HTMLInputElement, SearchFieldProps>(
  function SearchField({ icon, label, className = '', 'aria-label': ariaLabel, ...inputProps }, ref) {
    const id = useId();

    const input = (
      <div className={`search-field ${className}`}>
        <span className="search-field__icon">
          {icon ?? <SearchIcon size="sm" />}
        </span>
        <input
          ref={ref}
          id={id}
          type="text"
          className="search-field__input"
          aria-label={ariaLabel ?? label}
          {...inputProps}
        />
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
