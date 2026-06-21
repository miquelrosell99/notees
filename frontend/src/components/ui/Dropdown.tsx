/**
 * Dropdown Component
 * 
 * A dropdown selection component with search and multi-select support.
 */
import { useState, useRef, useEffect, useCallback, useId, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { Card } from './Card';
import { SelectTrigger } from './SelectTrigger';
import { useClickOutside } from '@/hooks/useClickOutside';
import { useViewportFlip } from '@/hooks/useViewportFlip';
import { useOverlaySurface } from '@/hooks/useOverlaySurface';
import './Dropdown.css';
import { Icon } from '@/components/ui/icons';

export type DropdownSize = 'sm' | 'md' | 'lg';

export interface DropdownOption<T = string> {
  /** Unique value for the option */
  value: T;
  /** Display label */
  label: string;
  /** Optional icon (MDI SVG path string — raw path data only) */
  icon?: string;
  /** Optional pre-rendered icon node (takes priority over `icon`) */
  iconNode?: ReactNode;
  /** Optional description */
  description?: string;
  /** Whether the option is disabled */
  disabled?: boolean;
  /** Group name for grouping options */
  group?: string;
}

export interface DropdownProps<T = string> {
  /** Available options */
  options: DropdownOption<T>[];
  /** Current value (single selection) */
  value?: T | null;
  /** Current values (multi-selection) */
  values?: T[];
  /** Change handler for single selection */
  onChange?: (value: T | null) => void;
  /** Change handler for multi-selection */
  onChangeMultiple?: (values: T[]) => void;
  /** Placeholder text */
  placeholder?: string;
  /** Whether multiple selection is enabled */
  multiple?: boolean;
  /** Whether search is enabled */
  searchable?: boolean;
  /** Whether the dropdown is clearable */
  clearable?: boolean;
  /** Whether the dropdown is disabled */
  disabled?: boolean;
  /** Size variant */
  size?: DropdownSize;
  /** Error state */
  error?: boolean;
  /** Error message */
  errorMessage?: string;
  /** Custom trigger renderer */
  renderTrigger?: (props: { isOpen: boolean; selectedLabel: string }) => ReactNode;
  /** Custom option renderer */
  renderOption?: (option: DropdownOption<T>, isSelected: boolean) => ReactNode;
  /** Extra content rendered next to the search input */
  searchExtra?: ReactNode;
  /** Content rendered at the bottom of the dropdown menu, below the options list */
  footer?: ReactNode;
  /** Empty state content */
  emptyContent?: ReactNode;
  /** Additional className */
  className?: string;
  /** ID for the container, used for label association */
  id?: string;
}

/**
 * Dropdown component for selecting from a list of options.
 */
export function Dropdown<T = string>({
  options,
  value,
  values = [],
  onChange,
  onChangeMultiple,
  placeholder = 'Select...',
  multiple = false,
  searchable = false,
  clearable = false,
  disabled = false,
  size = 'md',
  error = false,
  errorMessage,
  renderTrigger,
  renderOption,
  searchExtra,
  footer,
  emptyContent = 'No options',
  className = '',
  id,
}: DropdownProps<T>) {
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const errorId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Position menu with viewport flip
  const menuPosition = useViewportFlip(containerRef, isOpen, {
    maxHeight: 300,
    includeWidth: true,
    popupRef: menuRef,
  });

  // Close dropdown handler
  const handleClose = useCallback(() => {
    setIsOpen(false);
    setSearchQuery('');
  }, []);

  // Register with the global overlay stack so Escape closes the dropdown
  // regardless of where DOM focus is.
  useOverlaySurface({
    type: 'popup',
    enabled: isOpen,
    onClose: handleClose,
  });

  // Close on click outside
  useClickOutside([containerRef, menuRef], handleClose, isOpen);

  // Focus search input when opened (delayed for portal rendering)
  useEffect(() => {
    if (isOpen && searchable) {
      const timer = setTimeout(() => {
        searchInputRef.current?.focus();
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [isOpen, searchable]);

  // Filter options by search query
  const filteredOptions = options.filter(opt =>
    opt.label.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Group options if any have groups
  const groupedOptions = filteredOptions.reduce<Record<string, DropdownOption<T>[]>>((acc, opt) => {
    const group = opt.group || '';
    if (!acc[group]) acc[group] = [];
    acc[group].push(opt);
    return acc;
  }, {});

  const groups = Object.keys(groupedOptions).sort();

  // Get selected option(s)
  const selectedOptions = multiple
    ? options.filter(opt => values.includes(opt.value))
    : options.filter(opt => opt.value === value);

  const selectedLabel = multiple
    ? selectedOptions.map(opt => opt.label).join(', ') || placeholder
    : selectedOptions[0]?.label || placeholder;

  const handleToggle = useCallback(() => {
    if (disabled) return;
    setIsOpen(prev => !prev);
  }, [disabled]);

  const handleSelect = useCallback((option: DropdownOption<T>) => {
    if (option.disabled) return;

    if (multiple) {
      const newValues = values.includes(option.value)
        ? values.filter(v => v !== option.value)
        : [...values, option.value];
      onChangeMultiple?.(newValues);
    } else {
      onChange?.(option.value);
      setIsOpen(false);
      setSearchQuery('');
    }
  }, [multiple, values, onChange, onChangeMultiple]);

  const handleClear = useCallback(() => {
    if (multiple) {
      onChangeMultiple?.([]);
    } else {
      onChange?.(null);
    }
    setIsOpen(false);
  }, [multiple, onChange, onChangeMultiple]);

  const hasValue = multiple ? values.length > 0 : value != null;

  const isSelected = (option: DropdownOption<T>): boolean => {
    return multiple ? values.includes(option.value) : option.value === value;
  };

  const containerClasses = [
    'dropdown',
    `dropdown--${size}`,
    isOpen ? 'dropdown--open' : '',
    disabled ? 'dropdown--disabled' : '',
    error ? 'dropdown--error' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div id={id} className="dropdown-container">
      <div className={containerClasses} ref={containerRef}>
        {/* Trigger */}
        {renderTrigger ? (
          <button type="button" className="dropdown-custom-trigger" onClick={handleToggle}>
            {renderTrigger({ isOpen, selectedLabel })}
          </button>
        ) : (
          <SelectTrigger
            isOpen={isOpen}
            disabled={disabled}
            error={error}
            size={size}
            clearable={clearable}
            hasValue={hasValue}
            aria-invalid={error || undefined}
            aria-describedby={error && errorMessage ? errorId : undefined}
            onClear={handleClear}
            onClick={handleToggle}
          >
            <span className={`dropdown-value ${!hasValue ? 'dropdown-value--placeholder' : ''}`}>
              {selectedLabel}
            </span>
          </SelectTrigger>
        )}

        {/* Dropdown menu - rendered in portal */}
        {isOpen && createPortal(
          <Card
            ref={menuRef}
            className="dropdown-menu dropdown-menu--portal"
            elevation="high"
            padding={false}
            style={
              menuPosition
                ? {
                    position: 'absolute',
                    top: `${menuPosition.top}px`,
                    left: `${menuPosition.left}px`,
                    minWidth: `${menuPosition.width}px`,
                    maxHeight: `${menuPosition.maxHeight}px`,
                  }
                : { position: 'absolute', top: 0, left: 0, visibility: 'hidden' }
            }
          >
            {searchable && (
              <div className="dropdown-search">
                <input
                  ref={searchInputRef}
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search..."
                  aria-label="Search options"
                  className="dropdown-search-input"
                />
                {searchExtra}
              </div>
            )}

            <div className="dropdown-options">
              {filteredOptions.length === 0 ? (
                <div className="dropdown-empty">{emptyContent}</div>
              ) : (
                groups.map(group => (
                  <div key={group || 'default'} className="dropdown-group">
                    {group && <div className="dropdown-group-label">{group}</div>}
                    {groupedOptions[group].map(option => {
                      const selected = isSelected(option);
                      
                      if (renderOption) {
                        return (
                          <button
                            type="button"
                            key={String(option.value)}
                            onClick={() => handleSelect(option)}
                            className={`dropdown-option ${selected ? 'dropdown-option--selected' : ''} ${option.disabled ? 'dropdown-option--disabled' : ''}`}
                            disabled={option.disabled}
                          >
                            {renderOption(option, selected)}
                          </button>
                        );
                      }

                      return (
                        <button
                          key={String(option.value)}
                          type="button"
                          className={`dropdown-option ${selected ? 'dropdown-option--selected' : ''} ${option.disabled ? 'dropdown-option--disabled' : ''}`}
                          onClick={() => handleSelect(option)}
                          disabled={option.disabled}
                        >
                          {option.iconNode ? (
                            <span className="dropdown-option-icon">{option.iconNode}</span>
                          ) : option.icon ? (
                            <Icon path={option.icon} size={0.7} className="dropdown-option-icon" />
                          ) : null}
                          <div className="dropdown-option-content">
                            <span className="dropdown-option-label">{option.label}</span>
                            {option.description && (
                              <span className="dropdown-option-description">{option.description}</span>
                            )}
                          </div>
                          {selected && (
                            <Icon path={"mdi mdi-check"} size={0.6} className="dropdown-option-check" />
                          )}
                        </button>
                      );
                    })}
                  </div>
                ))
              )}
            </div>
            {footer && (
              <div className="dropdown-footer">
                {footer}
              </div>
            )}
          </Card>,
          document.body
        )}

      {/* Error message */}
      {error && errorMessage && (
        <span id={errorId} className="dropdown-error-message" role="alert">{errorMessage}</span>
      )}
      </div>
    </div>
  );
}
