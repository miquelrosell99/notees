/**
 * Checkbox Component
 *
 * A styled checkbox input component (check variant, default density —
 * the subset the metadata property editors use).
 *
 * Thin fleet wrapper over the normalized catalog checkbox
 * (src/components/ui/checkbox.tsx — Radix underneath): the container +
 * label composition, the sm/md/lg size scale, and the
 * checked/disabled/indeterminate register are the app's and live here.
 *
 * INTERACTION CONTRACT (bridge checklist #9 — documented override): the
 * pre-catalog primitive was a NATIVE <input type=checkbox>; the catalog
 * root is a Radix <button role=checkbox>. The public surface preserves
 * the native semantics that matter — checked/defaultChecked, name/value
 * form participation (Radix renders the hidden bubble input), label
 * association by htmlFor, role=checkbox + accessible name — with two
 * documented deltas: (1) onChange now receives the boolean state (the
 * change-event shape retired with the native input); (2) the ref targets
 * the focusable root (a button, not an input).
 *
 * Legacy hook classes: `checkbox-container` (+ the size/disabled
 * variants) and the label hooks stay — feature CSS compounds on them.
 */

import { forwardRef, useId, type ComponentPropsWithoutRef } from 'react';

import { Checkbox as CatalogCheckbox } from '@/components/ui/checkbox.js';
import { cn } from './cn.js';

export type CheckboxSize = 'sm' | 'md' | 'lg';

export interface CheckboxProps
  extends Omit<ComponentPropsWithoutRef<typeof CatalogCheckbox>, 'className' | 'size' | 'type' | 'onChange'> {
  /** Checkbox size */
  size?: CheckboxSize;
  /** Label text */
  label?: string;
  /** Additional className for the container */
  className?: string;
  /** Change handler — receives the new checked state. */
  onChange?: ((checked: boolean) => void) | undefined;
  /** Indeterminate (tri-state) flag. */
  indeterminate?: boolean | undefined;
}

const BOX_CLASSES: Record<CheckboxSize, string> = {
  sm: 'h-xs w-xs rounded-shape-md',
  md: 'h-sm w-sm rounded-shape-md',
  lg: 'h-md w-md rounded-shape-md',
};

export const Checkbox = forwardRef<HTMLButtonElement, CheckboxProps>(function Checkbox(
  {
    size = 'md',
    label,
    className = '',
    disabled,
    id,
    checked,
    defaultChecked,
    indeterminate = false,
    onChange,
    ...rest
  },
  ref,
) {
  const generatedId = useId();
  const checkboxId = id || `checkbox-${generatedId}`;

  return (
    <div
      className={cn(
        'checkbox-container flex items-start gap-2',
        `checkbox-container--${size}`,
        disabled && 'checkbox-container--disabled cursor-not-allowed opacity-50',
        className,
      )}
    >
      <CatalogCheckbox
        ref={ref}
        id={checkboxId}
        className={cn(
          'checkbox-input border-outline hover:border-primary',
          BOX_CLASSES[size],
        )}
        checked={indeterminate ? 'indeterminate' : checked}
        defaultChecked={defaultChecked}
        disabled={disabled}
        onCheckedChange={(state) => onChange?.(state === true)}
        {...rest}
      />
      {label && (
        <label htmlFor={checkboxId} className="checkbox-label-wrapper flex flex-col gap-micro">
          <span className="checkbox-label cursor-pointer text-sm text-on-surface">{label}</span>
        </label>
      )}
    </div>
  );
});
