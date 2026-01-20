/**
 * Dropdown Component
 * 
 * A dropdown selection component with search and multi-select support.
 */
import { useState, useRef, useEffect, useCallback, type ReactNode } from 'react';
import Icon from '@mdi/react';
import { mdiChevronDown, mdiClose, mdiCheck } from '@mdi/js';
import { Card } from './Card';
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
}: DropdownProps<T>) {
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Close on click outside
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
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
    <div className={containerClasses} ref={containerRef}>
      {/* Trigger */}
      {renderTrigger ? (
        <div onClick={handleToggle}>
          {renderTrigger({ isOpen, selectedLabel })}
        </div>
      ) : (
        <button
          type="button"
          className="dropdown-trigger"
          onClick={handleToggle}
          disabled={disabled}
          aria-haspopup="listbox"
          aria-expanded={isOpen}
        >
          <span className={`dropdown-value ${!value && !values.length ? 'dropdown-value--placeholder' : ''}`}>
            {selectedLabel}
          </span>
          <div className="dropdown-icons">
            {clearable && (value || values.length > 0) && (
              <button
                type="button"
                className="dropdown-clear"
                onClick={handleClear}
                aria-label="Clear selection"
              >
                <Icon path={mdiClose} size={0.6} />
              </button>
            )}
            <Icon
              path={mdiChevronDown}
              size={0.7}
              className={`dropdown-chevron ${isOpen ? 'dropdown-chevron--open' : ''}`}
            />
          </div>
        </button>
      )}

      {/* Dropdown menu */}
      {isOpen && (
        <Card className="dropdown-menu" elevation="high" padding={false}>
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
        </Card>
      )}

      {/* Error message */}
      {error && errorMessage && (
        <span className="dropdown-error-message">{errorMessage}</span>
      )}
    </div>
  );
}
