/**
 * Radio Component
 *
 * A styled radio input component — the check variant's single-selection
 * sibling: same density, same tokens, a dot instead of the checkmark.
 *
 * Thin fleet wrapper over the normalized catalog radio-group
 * (src/components/ui/radio-group.tsx — Radix underneath): the container
 * + label composition and the sm/md/lg size scale are the app's and live
 * here.
 *
 * INTERACTION CONTRACT (bridge checklist #9 — documented override): the
 * pre-catalog primitive was a standalone NATIVE <input type=radio> that
 * composed groups by sharing a `name`; the catalog is a Radix
 * RadioGroup (one Root owns the selection — arrow-key roving and
 * single-selection come from the group, as before, but selection is the
 * Root's `value`, not per-item `checked`). Groups therefore compose as
 * <RadioGroup value onValueChange> wrapping <Radio value> items — the
 * one app call site (the PDF export layout picker) composes this way.
 *
 * Legacy hook classes: `radio-container` (+ the size/disabled variants)
 * and the label hooks stay — feature CSS compounds on them.
 */

import { forwardRef, useId, type ReactNode } from 'react';

import {
  RadioGroup as CatalogRadioGroup,
  RadioGroupItem,
} from '@/components/ui/radio-group.js';
import { cn } from './cn.js';

export type RadioSize = 'sm' | 'md' | 'lg';

/** The group — owns the selection. Thin wrapper over the catalog Root. */
export const RadioGroup = forwardRef<
  HTMLDivElement,
  {
    /** The selected item's value. */
    value?: string | undefined;
    /** Selection change handler. */
    onValueChange?: ((value: string) => void) | undefined;
    /** Group name (form participation). */
    name?: string | undefined;
    disabled?: boolean | undefined;
    className?: string | undefined;
    children?: ReactNode;
    'aria-label'?: string | undefined;
    'aria-labelledby'?: string | undefined;
  }
>(function RadioGroup({ className = '', ...props }, ref) {
  return <CatalogRadioGroup ref={ref} className={cn('radio-group', className)} {...props} />;
});

export interface RadioProps {
  /** Item value (the group's selection matches this). */
  value: string;
  /** Radio size */
  size?: RadioSize;
  /** Label content (text or an icon+text composition) */
  label?: ReactNode;
  /** Additional className for the container */
  className?: string;
  disabled?: boolean | undefined;
  id?: string | undefined;
}

const DOT_CLASSES: Record<RadioSize, string> = {
  sm: 'h-xs w-xs',
  md: 'h-sm w-sm',
  lg: 'h-md w-md',
};

export const Radio = forwardRef<HTMLButtonElement, RadioProps>(function Radio(
  { value, size = 'md', label, className = '', disabled, id },
  ref,
) {
  const generatedId = useId();
  const radioId = id || `radio-${generatedId}`;

  return (
    <div
      className={cn(
        'radio-container flex items-start gap-2',
        `radio-container--${size}`,
        disabled && 'radio-container--disabled cursor-not-allowed opacity-50',
        className,
      )}
    >
      <RadioGroupItem
        ref={ref}
        id={radioId}
        value={value}
        disabled={disabled}
        className={cn('radio-input border-outline hover:border-primary', DOT_CLASSES[size])}
      />
      {label && (
        <label htmlFor={radioId} className="radio-label-wrapper flex flex-col gap-micro">
          <span className="radio-label cursor-pointer text-sm text-on-surface">{label}</span>
        </label>
      )}
    </div>
  );
});
