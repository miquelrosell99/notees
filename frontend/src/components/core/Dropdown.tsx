/**
 * Dropdown Component
 * 
 * A dropdown selection component with search and multi-select support.
 */
import { useState, useRef, useEffect, useCallback, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import Icon from '@mdi/react';
import { mdiChevronDown, mdiClose, mdiCheck } from '@mdi/js';
import { Card } from './Card';
import { Button } from './Button';
import './Dropdown.css';

export type DropdownSize = 'sm' | 'md' | 'lg';

export interface DropdownOption<T = string> {
  /** Unique value for the option */
  value: T;
  /** Display label */
  label: string;
  /** Optional icon (MDI path) */
  icon?: string;
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
  /** Empty state content */
  emptyContent?: ReactNode;
  /** Additional className */
  className?: string;
  /** Delete button callback - shows delete button with X icon next to dropdown */
  onDelete?: () => void;
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
  emptyContent = 'No options',
  className = '',
  onDelete,
}: DropdownProps<T>) {
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [menuPosition, setMenuPosition] = useState<{ top: number; left: number; width: number; maxHeight: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Update menu position when opened
  useEffect(() => {
    if (isOpen && containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      const viewportHeight = window.innerHeight;
      const spaceBelow = viewportHeight - rect.bottom;
      const spaceAbove = rect.top;
      const maxDropdownHeight = 300; // Match CSS default
      const gap = 4;
      
      // Determine if dropdown should open above or below
      let top: number;
      let maxHeight: number;
      
      if (spaceBelow >= maxDropdownHeight || spaceBelow > spaceAbove) {
        // Open below
        top = rect.bottom + window.scrollY + gap;
        maxHeight = Math.min(maxDropdownHeight, spaceBelow - gap * 2);
      } else {
        // Open above
        maxHeight = Math.min(maxDropdownHeight, spaceAbove - gap * 2);
        top = rect.top + window.scrollY - maxHeight - gap;
      }
      
      setMenuPosition({
        top,
        left: rect.left + window.scrollX,
        width: rect.width,
        maxHeight,
      });
    } else {
      setMenuPosition(null);
    }
  }, [isOpen]);

  // Close on click outside
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      // Check if click is outside both the container AND the portaled menu
      if (
        containerRef.current && 
        !containerRef.current.contains(target) &&
        menuRef.current &&
        !menuRef.current.contains(target)
      ) {
        setIsOpen(false);
        setSearchQuery('');
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsOpen(false);
        setSearchQuery('');
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isOpen]);

  // Focus search input when opened
  useEffect(() => {
    if (isOpen && searchable && searchInputRef.current) {
      searchInputRef.current.focus();
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

  const handleClear = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (multiple) {
      onChangeMultiple?.([]);
    } else {
      onChange?.(null);
    }
  }, [multiple, onChange, onChangeMultiple]);

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
    <div className="dropdown-container">
      <div className={containerClasses} ref={containerRef}>
        {/* Trigger */}
        {renderTrigger ? (
          <div onClick={handleToggle}>
            {renderTrigger({ isOpen, selectedLabel })}
          </div>
        ) : (
          <Card
            className="dropdown-trigger"
            onClick={handleToggle}
            variant="outlined"
            padding={false}
            elevation="none"
            interactive
            role="button"
            tabIndex={disabled ? -1 : 0}
            aria-haspopup="listbox"
            aria-expanded={isOpen}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                handleToggle();
              }
            }}
          >
            <div className="dropdown-trigger-content">
              <span className={`dropdown-value ${!value && !values.length ? 'dropdown-value--placeholder' : ''}`}>
                {selectedLabel}
              </span>
              <div className="dropdown-icons">
                {clearable && (value || values.length > 0) && (
                  <div
                    className="dropdown-clear"
                    onClick={handleClear}
                    role="button"
                    tabIndex={0}
                    aria-label="Clear selection"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        handleClear(e as any);
                      }
                    }}
                  >
                    <Icon path={mdiClose} size={0.6} />
                  </div>
                )}
                <Icon
                  path={mdiChevronDown}
                  size={0.7}
                  className={`dropdown-chevron ${isOpen ? 'dropdown-chevron--open' : ''}`}
                />
              </div>
            </div>
          </Card>
        )}

      {/* Dropdown menu - rendered in portal */}
      {isOpen && menuPosition && createPortal(
        <Card
          ref={menuRef}
          className="dropdown-menu dropdown-menu--portal" 
          elevation="high" 
          padding={false}
          style={{
            position: 'absolute',
            top: `${menuPosition.top}px`,
            left: `${menuPosition.left}px`,
            minWidth: `${menuPosition.width}px`,
            maxHeight: `${menuPosition.maxHeight}px`,
          }}
        >
          {searchable && (
            <div className="dropdown-search">
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search..."
                className="dropdown-search-input"
              />
            </div>
          )}

          <div className="dropdown-options" role="listbox">
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
                        <div
                          key={String(option.value)}
                          onClick={() => handleSelect(option)}
                          className={`dropdown-option ${selected ? 'dropdown-option--selected' : ''} ${option.disabled ? 'dropdown-option--disabled' : ''}`}
                          role="option"
                          aria-selected={selected}
                        >
                          {renderOption(option, selected)}
                        </div>
                      );
                    }

                    return (
                      <button
                        key={String(option.value)}
                        type="button"
                        className={`dropdown-option ${selected ? 'dropdown-option--selected' : ''} ${option.disabled ? 'dropdown-option--disabled' : ''}`}
                        onClick={() => handleSelect(option)}
                        disabled={option.disabled}
                        role="option"
                        aria-selected={selected}
                      >
                        {option.icon && (
                          <Icon path={option.icon} size={0.7} className="dropdown-option-icon" />
                        )}
                        <div className="dropdown-option-content">
                          <span className="dropdown-option-label">{option.label}</span>
                          {option.description && (
                            <span className="dropdown-option-description">{option.description}</span>
                          )}
                        </div>
                        {selected && (
                          <Icon path={mdiCheck} size={0.6} className="dropdown-option-check" />
                        )}
                      </button>
                    );
                  })}
                </div>
              ))
            )}
          </div>
        </Card>,
        document.body
      )}

        {/* Error message */}
        {error && errorMessage && (
          <span className="dropdown-error-message">{errorMessage}</span>
        )}
      </div>
      
      {/* Delete button */}
      {onDelete && (
        <Button
          icon={mdiClose}
          iconOnly
          variant="ghost"
          size={size}
          onClick={onDelete}
          aria-label="Delete"
          className="dropdown-delete-btn"
        />
      )}
    </div>
  );
}
