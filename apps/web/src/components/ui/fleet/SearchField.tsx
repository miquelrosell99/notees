/**
 * SearchField — Rounded search input with left icon.
 *
 * A presentational input component styled as a search bar (rounded corners,
 * tinted background, left-side icon). Does NOT include dropdown/results —
 * that's the caller's job. Used by SearchBox and NodeSelector.
 *
 * Thin fleet wrapper over the normalized catalog input
 * (src/components/ui/input.tsx): the filled-pill container, the left
 * icon, the clear affordance, the optional visible label, and the
 * borderless variant are the app's and live here. The wrapper-carried
 * focus ring (--shadow-focus-ring hugs the whole pill, not the input box
 * inside the padding) and the clear button's invisible hit-area floor
 * (::after) ride this file's co-located CSS — the utility layer can't
 * express the pseudo-element floor cleanly.
 *
 * Legacy hook classes: `search-field` (+ `search-field--borderless`),
 * `search-field__input/icon/clear/label`, and `search-field-wrapper`
 * stay — tests and feature CSS compound on them.
 */
import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from 'react';

import { Input as CatalogInput } from '@/components/ui/input.js';
import { Icon } from '../../../ui/Icon.js';
import { cn } from './cn.js';
import './SearchField.css';

export interface SearchFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  /** Icon rendered on the left (defaults to a search icon) */
  icon?: ReactNode;
  /** Visible label text (also used as accessible name when visible) */
  label?: string;
  /** Pill size — "md" (default, 36px) stands full surfaces and roomy chrome
   * rows; "sm" (30px) rides compact rows and anchored picker popovers,
   * matching the sm controls beside those lists (owner 2026-10-21). The
   * pill's block size is ALWAYS the input's button-height token — the
   * wrapper carries no block padding (owner 2026-10-22: the old py-2
   * stacked on h-button-md and doubled the vertical air). */
  size?: 'md' | 'sm' | undefined;
  /** Additional CSS class on the wrapper */
  className?: string;
  /** Clear affordance: with a non-empty `value`, an × renders inside the
   * right edge and calls this (the host clears its state). */
  onClear?: (() => void) | undefined;
}

export const SearchField = forwardRef<HTMLInputElement, SearchFieldProps>(
  function SearchField({ icon, label, size = 'md', className = '', 'aria-label': ariaLabel, onClear, ...inputProps }, ref) {
    const id = useId();
    const hasValue = typeof inputProps.value === 'string' && inputProps.value !== '';

    const input = (
      <div
        className={cn(
          'search-field flex items-center gap-2 rounded-item px-3 transition-colors duration-short ease-standard',
          size === 'sm' && 'search-field--sm',
          className,
        )}
      >
        <span className="search-field__icon flex shrink-0 items-center text-on-surface-variant">
          {icon ?? <Icon path="mdi mdi-magnify" size="sm" />}
        </span>
        <CatalogInput
          ref={ref}
          id={id}
          type="text"
          className={cn(
            'search-field__input min-w-0 flex-1 border-none bg-transparent text-base text-on-surface placeholder:text-on-surface-variant focus-visible:ring-0',
            size === 'sm' && 'h-button-sm',
          )}
          aria-label={ariaLabel ?? label}
          {...inputProps}
        />
        {hasValue && onClear !== undefined && (
          <button
            type="button"
            className="search-field__clear relative inline-flex shrink-0 cursor-pointer items-center justify-center rounded-full border-none bg-transparent p-0 text-on-surface-variant hover:bg-hover-overlay hover:text-on-surface"
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
        <div className="search-field-wrapper flex flex-col gap-1">
          <label htmlFor={id} className="search-field__label text-sm font-medium text-on-surface-variant">{label}</label>
          {input}
        </div>
      );
    }

    return input;
  },
);
