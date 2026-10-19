/**
 * Dropdown Component
 *
 * A dropdown selection component with search and multi-select support.
 *
 * Rebuilt on the catalog combobox composition (the register's scheduled
 * migration, 2026-10-19): the Radix popover owns portal + popper
 * positioning (viewport flip/shift/clamp replace the old imperative
 * useViewportFlip fit) and the catalog cmdk command owns the list
 * semantics — the listbox/option ARIA, the label-only filter (each item's
 * `value` is its label, so custom renderers can't pollute the match),
 * the arrow-key walk, and the empty state. The fleet register stays
 * fleet-owned per the sourcing table: the boxed SelectTrigger, the menu
 * surface/item/search CSS hooks (Dropdown.css), the MDI option chrome,
 * the multi-select/search/groups/custom-renderer contracts, and the
 * Escape LIFO ordering through the app overlay stack (useOverlaySurface —
 * Radix's own Escape and outside-pointer dismissal stay enabled, the
 * Modal-wrapper precedent: onEscapeKeyDown is only prevented so the
 * STACK stays the authority, never two Escape handlers).
 *
 * INTERACTION CONTRACTS PRESERVED (bridge checklist #9 — documented):
 * - single select fires onChange + closes; multi toggles and stays open
 * - filter matches option LABELS only (substring semantics; cmdk's
 *   subsequence matcher is a superset — every old match still matches)
 * - groups sort alphabetically; the empty state shows when the filter
 *   (or the option list itself) is empty
 * - the trigger keeps the full SelectTrigger register (sizes, clear,
 *   error, custom renderer)
 * - options render as cmdk items (role="option" in the listbox) — the
 *   a11y upgrade from the old <button> rows; the marker classes
 *   (dropdown-option, --selected, --disabled, dropdown-option-label, …)
 *   are unchanged for feature CSS
 *
 * Popper-owned CSS vars (set by Radix on the content, cited in
 * Dropdown.css, allowlisted in the drift gate):
 * "--radix-popover-trigger-width": the menu's min-width anchor.
 */
import { useState, useRef, useEffect, useCallback, useId, type ReactNode } from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command.js';
import { SelectTrigger } from './SelectTrigger.js';
import { useOverlaySurface } from './overlay-hooks.js';
import './Dropdown.css';
import { Icon } from '../../../ui/Icon.js';
import { cn } from './cn.js';

export type DropdownSize = 'sm' | 'md' | 'lg';

export interface DropdownOption<T = string> {
  /** Unique value for the option */
  value: T;
  /** Display label */
  label: string;
  /** Optional icon (MDI SVG path string — raw path data only) */
  icon?: string | undefined;
  /** Optional pre-rendered icon node (takes priority over `icon`) */
  iconNode?: ReactNode | undefined;
  /** Optional description */
  description?: string | undefined;
  /** Whether the option is disabled */
  disabled?: boolean | undefined;
  /** Group name for grouping options */
  group?: string | undefined;
}

export interface DropdownProps<T = string> {
  /** Available options */
  options: DropdownOption<T>[];
  /** Current value (single selection) */
  value?: T | null | undefined;
  /** Current values (multi-selection) */
  values?: T[] | undefined;
  /** Change handler for single selection */
  onChange?: ((value: T | null) => void) | undefined;
  /** Change handler for multi-selection */
  onChangeMultiple?: ((values: T[]) => void) | undefined;
  /** Placeholder text */
  placeholder?: string | undefined;
  /** Whether multiple selection is enabled */
  multiple?: boolean | undefined;
  /** Whether search is enabled */
  searchable?: boolean | undefined;
  /** Whether the dropdown is clearable */
  clearable?: boolean | undefined;
  /** Whether the dropdown is disabled */
  disabled?: boolean | undefined;
  /** Size variant */
  size?: DropdownSize | undefined;
  /** Error state */
  error?: boolean | undefined;
  /** Error message */
  errorMessage?: string | undefined;
  /** Custom trigger renderer */
  renderTrigger?: ((props: { isOpen: boolean; selectedLabel: string }) => ReactNode) | undefined;
  /** Custom option renderer */
  renderOption?: ((option: DropdownOption<T>, isSelected: boolean) => ReactNode) | undefined;
  /** Extra content rendered next to the search input */
  searchExtra?: ReactNode | undefined;
  /** Content rendered at the bottom of the dropdown menu, below the options list */
  footer?: ReactNode | undefined;
  /** Empty state content */
  emptyContent?: ReactNode | undefined;
  /** Additional className */
  className?: string | undefined;
  /** ID for the container, used for label association */
  id?: string | undefined;
  /** Accessible name for the trigger (the selected value renders inside) */
  ariaLabel?: string | undefined;
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
  ariaLabel,
}: DropdownProps<T>) {
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const errorId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Close dropdown handler
  const handleClose = useCallback(() => {
    setIsOpen(false);
    setSearchQuery('');
  }, []);

  // Register with the overlay stack so Escape closes the dropdown
  // regardless of where DOM focus is. Radix's own Escape is disabled on
  // the content — the stack stays the single Escape authority.
  useOverlaySurface({
    type: 'popup',
    enabled: isOpen,
    onClose: handleClose,
  });

  // Focus search input when opened (the popover is non-modal, so Radix
  // moves no focus itself).
  useEffect(() => {
    if (isOpen && searchable) {
      const timer = setTimeout(() => {
        searchInputRef.current?.focus();
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [isOpen, searchable]);

  // Group options if any have groups
  const groupedOptions = options.reduce<Record<string, DropdownOption<T>[]>>((acc, opt) => {
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

  const renderOptionContent = (option: DropdownOption<T>, selected: boolean): ReactNode => {
    if (renderOption) {
      return renderOption(option, selected);
    }
    return (
      <>
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
      </>
    );
  };

  return (
    <div id={id} className="dropdown-container">
      <PopoverPrimitive.Root
        open={isOpen}
        onOpenChange={(open) => {
          if (!open) handleClose();
        }}
        modal={false}
      >
        <PopoverPrimitive.Anchor asChild>
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
                ariaLabel={ariaLabel}
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
          </div>
        </PopoverPrimitive.Anchor>

        {/* Dropdown menu - the popover portal owns positioning; the inner
            card carries the fleet menu register (and the animation — the
            popper transform lives on the outer element, so the keyframes
            never fight it). */}
        <PopoverPrimitive.Portal>
          <PopoverPrimitive.Content
            side="bottom"
            align="start"
            sideOffset={4}
            collisionPadding={16}
            // The popup is a combobox surface: the cmdk listbox/search own
            // the ARIA — the popover wrapper stays presentational (Radix
            // defaults it to role="dialog").
            role="presentation"
            onEscapeKeyDown={(event) => event.preventDefault()}
            onPointerDownOutside={(event) => {
              // The trigger owns the toggle: a press on it must not
              // dismiss here (the trigger's own click toggles it closed).
              const target = event.target as HTMLElement | null;
              if (target !== null && containerRef.current?.contains(target)) {
                event.preventDefault();
              }
            }}
          >
            <div className="dropdown-menu dropdown-menu--portal card">
              <Command
                className="dropdown-command"
                shouldFilter={searchable}
                // cmdk wires the input's accessible name from this label
                // (aria-labelledby always wins over the input's own
                // aria-label).
                {...(searchable ? { label: 'Search options' } : {})}
              >
                {searchable && (
                  <div className="dropdown-search">
                    <CommandInput
                      ref={searchInputRef}
                      value={searchQuery}
                      onValueChange={setSearchQuery}
                      placeholder="Search..."
                      className="dropdown-search-input"
                    />
                    {searchExtra}
                  </div>
                )}
                <CommandList className="dropdown-options">
                  <CommandEmpty className="dropdown-empty">{emptyContent}</CommandEmpty>
                  {groups.map(group => (
                    <CommandGroup
                      key={group || 'default'}
                      heading={group || undefined}
                      className="dropdown-group"
                    >
                      {(groupedOptions[group] ?? []).map(option => {
                        const selected = isSelected(option);
                        return (
                          <CommandItem
                            key={String(option.value)}
                            // The filter matches labels only — custom
                            // renderers can't pollute the match string.
                            value={option.label}
                            disabled={option.disabled === true}
                            onSelect={() => handleSelect(option)}
                            className={cn(
                              'dropdown-option',
                              selected && 'dropdown-option--selected',
                              option.disabled && 'dropdown-option--disabled',
                            )}
                          >
                            {renderOptionContent(option, selected)}
                          </CommandItem>
                        );
                      })}
                    </CommandGroup>
                  ))}
                </CommandList>
              </Command>

              {footer && (
                <div className="dropdown-footer">
                  {footer}
                </div>
              )}
            </div>
          </PopoverPrimitive.Content>
        </PopoverPrimitive.Portal>
      </PopoverPrimitive.Root>

      {/* Error message */}
      {error && errorMessage && (
        <span id={errorId} className="dropdown-error-message" role="alert">{errorMessage}</span>
      )}
    </div>
  );
}
