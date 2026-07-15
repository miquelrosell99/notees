/**
 * Search box component (controlled)
 *
 * A generic, domain-agnostic search input with a dropdown result list and
 * keyboard navigation. The caller provides the query, result list, loading
 * state, and renderers. Feature code should use the wrapper in
 * `features/content/components/nodes/NodeSearchBox.tsx` to wire Notees search
 * hooks and default node rendering.
 */
import { useState, useCallback, useRef, useEffect, useLayoutEffect, type ReactNode } from 'react';
import { autoUpdate, computePosition, flip, offset, shift } from '@floating-ui/dom';
import { Spinner } from '@/components/ui/Spinner';
import { useKeyboardListNav } from '@/hooks/useKeyboardListNav';
import { SearchField } from './SearchField';
import './SearchBox.css';

/** Gap between the input and the dropdown. */
const DROPDOWN_GAP = 4;
/** Viewport edge clearance for the dropdown. */
const DROPDOWN_EDGE_PADDING = 8;

export interface SearchBoxProps<T> {
  /** Current query value */
  query: string;
  /** Called when the query changes */
  onQueryChange: (query: string) => void;
  /** Items to display in the dropdown */
  results: T[];
  /** Whether results are loading */
  isLoading?: boolean;
  /** Render a single result item */
  renderItem: (item: T) => ReactNode;
  /** Extract a stable key for a result item */
  getKey: (item: T) => string | number;
  /** Called when the user selects an item */
  onSelect: (item: T) => void;
  /** Placeholder text for the input */
  placeholder?: string;
  /** Additional CSS class */
  className?: string;
  /** Focus the input on mount */
  focusOnMount?: boolean;
  /** Show a "Create ..." option when the query is non-empty */
  showCreate?: boolean;
  /** Called when the create option is selected (receives the current query) */
  onCreate?: (query: string) => void;
  /** Called when the dropdown is dismissed */
  onClose?: () => void;
}

export function SearchBox<T>({
  query,
  onQueryChange,
  results,
  isLoading = false,
  renderItem,
  getKey,
  onSelect,
  placeholder = 'Search...',
  className = '',
  focusOnMount = false,
  showCreate = false,
  onCreate,
  onClose,
}: SearchBoxProps<T>) {
  const [isOpen, setIsOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const showCreateOption = showCreate && query.trim().length > 0 && !isLoading;
  const totalItems = results.length + (showCreateOption ? 1 : 0);

  // Auto-focus if requested
  useEffect(() => {
    if (focusOnMount && inputRef.current) {
      inputRef.current.focus();
    }
  }, [focusOnMount]);

  // Position the fixed dropdown with Floating UI. autoUpdate keeps it anchored
  // to the input on scroll/resize; flip moves it above when there's no room
  // below. top/left/width are written imperatively to the dropdown element so
  // repositioning never goes through React renders.
  useLayoutEffect(() => {
    if (!isOpen) return;
    const reference = containerRef.current;
    const floating = dropdownRef.current;
    if (!reference || !floating) return;

    const update = () => {
      computePosition(reference, floating, {
        placement: 'bottom-start',
        strategy: 'fixed',
        middleware: [
          offset(DROPDOWN_GAP),
          flip({ padding: DROPDOWN_EDGE_PADDING, fallbackPlacements: ['top-start'] }),
          shift({ padding: DROPDOWN_EDGE_PADDING, crossAxis: true }),
        ],
      }).then(({ x, y }) => {
        floating.style.left = `${x}px`;
        floating.style.top = `${y}px`;
        floating.style.right = 'auto';
        floating.style.width = `${reference.getBoundingClientRect().width}px`;
        floating.style.visibility = 'visible';
      });
    };

    update();
    return autoUpdate(reference, floating, update);
  }, [isOpen]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as HTMLElement)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    onQueryChange(value);
    setIsOpen(value.length > 0);
  }, [onQueryChange]);

  const handleSelect = useCallback((item: T | 'create') => {
    onQueryChange('');
    setIsOpen(false);

    if (item === 'create') {
      onCreate?.(query);
      return;
    }

    onSelect(item);
  }, [onQueryChange, onCreate, onSelect, query]);

  // Helper: get item by flat index (accounting for create option)
  const getItemByIndex = useCallback((flatIndex: number): T | 'create' | null => {
    if (showCreateOption && flatIndex === 0) {
      return 'create';
    }
    const adjustedIndex = showCreateOption ? flatIndex - 1 : flatIndex;
    if (adjustedIndex >= 0 && adjustedIndex < results.length) {
      return results[adjustedIndex];
    }
    return null;
  }, [showCreateOption, results]);

  // Keyboard list navigation
  const handleSelectByIndex = useCallback((index: number) => {
    if (totalItems > 0) {
      const item = getItemByIndex(index);
      if (item) handleSelect(item as T);
    }
  }, [totalItems, getItemByIndex, handleSelect]);

  const handleCloseList = useCallback(() => {
    onQueryChange('');
    setIsOpen(false);
    inputRef.current?.blur();
    onClose?.();
  }, [onQueryChange, onClose]);

  const { selectedIndex, setSelectedIndex, handleKeyDown } = useKeyboardListNav({
    totalItems,
    onSelect: handleSelectByIndex,
    onClose: handleCloseList,
    isOpen,
  });

  const handleResultClick = useCallback((index: number) => {
    const item = getItemByIndex(index);
    if (item) {
      handleSelect(item as T);
    }
  }, [getItemByIndex, handleSelect]);

  return (
    <div ref={containerRef} className={`search-box ${className}`}>
      <SearchField
        ref={inputRef}
        value={query}
        onChange={handleInputChange}
        onFocus={() => {
          if (query.length > 0) {
            setIsOpen(true);
          }
        }}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
      />

      {isOpen && (
        <div
          ref={dropdownRef}
          className="search-dropdown search-dropdown--fixed"
          // top/left/width are set imperatively by Floating UI; hidden until
          // the first position is computed
          style={{ visibility: 'hidden' }}
        >
          {isLoading && (
            <div className="search-loading"><Spinner size="sm" label="Searching..." /></div>
          )}

          {!isLoading && totalItems === 0 && (
            <div className="search-empty">No results found</div>
          )}

          {!isLoading && totalItems > 0 && (
            <ul className="search-results">
              {showCreateOption && (
                <li key="create">
                  <button
                    type="button"
                    className={`search-result-item search-result-item--create ${selectedIndex === 0 ? 'search-result-item--selected' : ''}`}
                    onClick={() => handleResultClick(0)}
                    onMouseEnter={() => setSelectedIndex(0)}
                  >
                    <span className="result-icon">+</span>
                    <span className="result-title">Create &quot;{query}&quot;</span>
                  </button>
                </li>
              )}
              {results.map((item, itemIndex) => {
                const flatIndex = (showCreateOption ? 1 : 0) + itemIndex;
                return (
                  <li key={getKey(item)}>
                    <button
                      type="button"
                      className={`search-result-item ${selectedIndex === flatIndex ? 'search-result-item--selected' : ''}`}
                      onClick={() => handleResultClick(flatIndex)}
                      onMouseEnter={() => setSelectedIndex(flatIndex)}
                    >
                      {renderItem(item)}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
