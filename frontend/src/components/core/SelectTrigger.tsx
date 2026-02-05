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
import Icon from '@mdi/react';
import { mdiChevronDown, mdiClose } from '@mdi/js';
import { Card } from './Card';
import { Button } from './Button';
import './SelectTrigger.css';

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
}: SelectTriggerProps) {
  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
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
      <Card
        className={triggerClasses}
        onClick={disabled ? undefined : onClick}
        variant="default"
        padding={false}
        elevation="none"
        interactive={!disabled}
        role="button"
        tabIndex={disabled ? -1 : tabIndex}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-label={ariaLabel}
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
              path={mdiChevronDown}
              size={0.7}
              className={isOpen ? 'select-trigger__chevron-icon--open' : ''}
            />
          </div>
        </div>
      </Card>

      {/* Clear button - outside the trigger */}
      {clearable && hasValue && onClear && (
        <Button
          icon={mdiClose}
          iconOnly
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
