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
 */
import { type ReactNode, type KeyboardEvent, type MouseEvent } from 'react';

import { Button } from './Button';
import './SelectTrigger.css';
import { Icon } from '@/components/ui/icons';

export type SelectTriggerSize = 'sm' | 'md' | 'lg';

export interface SelectTriggerProps {
  /** Whether the dropdown is open */
  isOpen: boolean;
  /** Whether the trigger is disabled */
  disabled?: boolean;
  /** Whether to show error state */
  error?: boolean;
  /** Size variant */
  size?: SelectTriggerSize;
  /** Content to display in the trigger */
  children: ReactNode;
  /** Whether to show the clear button */
  clearable?: boolean;
  /** Whether there is content to clear (controls clear button visibility) */
  hasValue?: boolean;
  /** Click handler for the trigger */
  onClick: () => void;
  /** Click handler for the clear button */
  onClear?: (e: MouseEvent) => void;
  /** Additional CSS class */
  className?: string;
  /** Tab index */
  tabIndex?: number;
  /** ARIA label */
  ariaLabel?: string;
  /** Whether the field has an error (for aria-invalid) */
  'aria-invalid'?: boolean;
  /** ID of element describing this field (for aria-describedby) */
  'aria-describedby'?: string;
}

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
  const handleKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick();
    }
  };

  const handleClearClick = (e: MouseEvent) => {
    e.stopPropagation();
    onClear?.(e);
  };

  const containerClasses = [
    'select-trigger-container',
    clearable && hasValue && onClear && 'select-trigger-container--with-clear',
  ]
    .filter(Boolean)
    .join(' ');

  const triggerClasses = [
    'select-trigger',
    `select-trigger--${size}`,
    isOpen && 'select-trigger--open',
    error && 'select-trigger--error',
    disabled && 'select-trigger--disabled',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={containerClasses}>
      <button
        type="button"
        className={triggerClasses}
        onClick={disabled ? undefined : onClick}
        disabled={disabled}
        tabIndex={disabled ? -1 : tabIndex}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedby}
        data-invalid={ariaInvalid || undefined}
        onKeyDown={handleKeyDown}
      >
        <div className="select-trigger__content">
          {/* Main content area */}
          <div className="select-trigger__value">
            {children}
          </div>

          {/* Chevron icon */}
          <div className="select-trigger__chevron">
            <Icon
              path={"mdi mdi-chevron-down"}
              size={0.7}
              className={isOpen ? 'select-trigger__chevron-icon--open' : ''}
            />
          </div>
        </div>
      </button>

      {/* Clear button - outside the trigger */}
      {clearable && hasValue && onClear && (
        <Button
          icon={"mdi mdi-close"}
          variant="ghost"
          size="sm"
          onClick={handleClearClick}
          aria-label="Clear selection"
          className="select-trigger__clear-btn"
        />
      )}
    </div>
  );
}
