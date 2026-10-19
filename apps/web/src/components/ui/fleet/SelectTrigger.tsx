/**
 * SelectTrigger - Common trigger component for select/dropdown inputs
 *
 * Provides consistent styling and behavior for:
 * - Dropdown component
 * - NodePicker component
 * - Any other select-like components
 *
 * Features:
 * - Card-based appearance with border
 * - Chevron icon that rotates when open
 * - Optional clear button (outside to the right)
 * - Keyboard navigation support
 *
 * Thin fleet wrapper over the normalized catalog button
 * (src/components/ui/button.tsx — the boxed field register applied to a
 * trigger, the Input family): the sm/md/lg row heights, the open/error
 * states, the chevron, and the clear affordance are the app's and live
 * here. The fleet field register overrides the button's default variant
 * (no press scale, the 12px input corner, no hover wash) through the
 * class merge.
 *
 * INTERACTION CONTRACT (bridge checklist #9 — documented override): the
 * pre-catalog primitive fired onClick on Enter/Space KEYDOWN via a
 * keydown shim; the catalog button uses the native button contract
 * (Enter fires click, Space fires on keyup) — the shim is dropped, the
 * aria-haspopup/aria-expanded surface is unchanged.
 *
 * Legacy hook classes: `select-trigger` (+ size/open/error/disabled
 * variants), `select-trigger__content/value/chevron`, and
 * `select-trigger-container` stay — feature CSS and tests compound on
 * them.
 */
import { type ReactNode, type MouseEvent } from 'react';

import { Button as CatalogButton } from '@/components/ui/button.js';
import { Button } from './Button.js';
import { Icon } from '../../../ui/Icon.js';
import { cn } from './cn.js';

export type SelectTriggerSize = 'sm' | 'md' | 'lg';

export interface SelectTriggerProps {
  /** Whether the dropdown is open */
  isOpen: boolean;
  /** Whether the trigger is disabled */
  disabled?: boolean | undefined;
  /** Whether to show error state */
  error?: boolean | undefined;
  /** Size variant */
  size?: SelectTriggerSize | undefined;
  /** Content to display in the trigger */
  children: ReactNode;
  /** Whether to show the clear button */
  clearable?: boolean | undefined;
  /** Whether there is content to clear (controls clear button visibility) */
  hasValue?: boolean | undefined;
  /** Click handler for the trigger */
  onClick: () => void;
  /** Click handler for the clear button */
  onClear?: ((e: MouseEvent) => void) | undefined;
  /** Additional CSS class */
  className?: string | undefined;
  /** Tab index */
  tabIndex?: number | undefined;
  /** ARIA label */
  ariaLabel?: string | undefined;
  /** Whether the field has an error (for aria-invalid) */
  'aria-invalid'?: boolean | undefined;
  /** ID of element describing this field (for aria-describedby) */
  'aria-describedby'?: string | undefined;
}

const CONTENT_CLASSES: Record<SelectTriggerSize, string> = {
  sm: 'min-h-md px-3',
  md: 'min-h-lg px-4',
  lg: 'min-h-xl px-5',
};

/**
 * SelectTrigger Component
 */
export function SelectTrigger({
  isOpen,
  disabled = false,
  error = false,
  size = 'md',
  children,
  clearable = false,
  hasValue = false,
  onClick,
  onClear,
  className = '',
  tabIndex = 0,
  ariaLabel,
  'aria-invalid': ariaInvalid,
  'aria-describedby': ariaDescribedby,
}: SelectTriggerProps) {
  const handleClearClick = (e: MouseEvent) => {
    e.stopPropagation();
    onClear?.(e);
  };

  return (
    <div
      className={cn(
        'select-trigger-container flex w-full items-center gap-1',
        clearable && hasValue && onClear && 'select-trigger-container--with-clear',
      )}
    >
      <CatalogButton
        type="button"
        variant="ghost"
        disabled={disabled}
        tabIndex={disabled ? -1 : tabIndex}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedby}
        data-invalid={ariaInvalid || undefined}
        onClick={disabled ? undefined : onClick}
        className={cn(
          'select-trigger h-auto w-full cursor-pointer rounded-input border-outline-variant bg-surface font-normal text-on-surface',
          'active:scale-100 hover:bg-surface',
          'transition-[border-color,box-shadow] duration-short ease-standard',
          CONTENT_CLASSES[size],
          `select-trigger--${size}`,
          isOpen && 'select-trigger--open border-primary',
          error && 'select-trigger--error border-error',
          disabled && 'select-trigger--disabled cursor-not-allowed opacity-50',
          className,
        )}
      >
        <span className="select-trigger__content flex w-full items-center justify-between gap-1">
          {/* Main content area */}
          <span className="select-trigger__value flex min-w-0 flex-1 items-center gap-1">
            {children}
          </span>

          {/* Chevron icon */}
          <span className="select-trigger__chevron flex shrink-0 items-center text-on-surface-variant">
            <Icon
              path={"mdi mdi-chevron-down"}
              size={0.7}
              className={cn('transition-transform duration-short ease-standard', isOpen && 'select-trigger__chevron-icon--open rotate-180')}
            />
          </span>
        </span>
      </CatalogButton>

      {/* Clear button - outside the trigger */}
      {clearable && hasValue && onClear && (
        <Button
          icon={"mdi mdi-close"}
          variant="ghost"
          size="sm"
          onClick={handleClearClick}
          aria-label="Clear selection"
          className="select-trigger__clear-btn shrink-0"
        />
      )}
    </div>
  );
}
