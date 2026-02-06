/**
 * SearchDropdown - Reusable dropdown component for search results
 * 
 * Consolidates duplicated dropdown logic:
 * - Keyboard navigation (ArrowUp/Down, Enter, Escape)
 * - Highlight & selection state
 * - Open/close handling
 * - Positioning (fixed, portal, or inline)
 * - Loading/empty states
 * - Optional "create new" option
 * 
 * Consumers just pass:
 * - items: Array of items to display
 * - onSelect: Handler for item selection
 * - renderItem: Custom renderer for each item
 * - onCreate: Optional handler for creating new items
 * - position: Positioning strategy ('fixed' | 'portal' | 'inline')
 */
import { useState, useCallback, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useClickOutside } from '@/hooks/useClickOutside';
import { useEscapeKey } from '@/hooks/useEscapeKey';
import './SearchDropdown.css';

export interface SearchDropdownItem<T = any> {
  /** The actual data item */
  data: T;
  /** Unique key for the item */
  key: string | number;
  /** Whether this item is disabled */
  disabled?: boolean;
}

export interface SearchDropdownProps<T = any> {
  /** Array of items to display */
  items: SearchDropdownItem<T>[];
  /** Callback when an item is selected */
  onSelect: (item: T) => void;
  /** Custom renderer for each item */
  renderItem: (item: T, isHighlighted: boolean) => React.ReactNode;
  /** Whether the dropdown is open */
  isOpen: boolean;
  /** Callback to close the dropdown */
  onClose: () => void;
  /** Optional create handler - shows "Create..." option */
  onCreate?: (query: string) => void;
  /** Query string for create option display */
  createQuery?: string;
  /** Custom create option text */
  createText?: string;
  /** Positioning strategy */
  position?: 'fixed' | 'portal' | 'inline';
  /** Position coordinates (for fixed/portal modes) */
  coordinates?: { top: number; left: number; width?: number };
  /** Loading state */
  isLoading?: boolean;
  /** Empty state message */
  emptyMessage?: string;
  /** Container ref for positioning relative to (portal mode) */
  containerRef?: React.RefObject<HTMLElement>;
  /** Additional CSS class */
  className?: string;
  /** Footer content */
  footer?: React.ReactNode;
  /** Max height for dropdown */
  maxHeight?: string;
}

export function SearchDropdown<T = any>({
  items,
  onSelect,
  renderItem,
  isOpen,
  onClose,
  onCreate,
  createQuery = '',
  createText,
  position = 'inline',
  coordinates,
  isLoading = false,
  emptyMessage = 'No results found',
  containerRef,
  className = '',
  footer,
  maxHeight = '300px',
}: SearchDropdownProps<T>) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const showCreateOption = onCreate && createQuery.trim().length > 0 && !isLoading;
  const totalItems = items.length + (showCreateOption ? 1 : 0);

  // Reset selection when items change
  useEffect(() => {
    setSelectedIndex(0);
  }, [items.length, createQuery]);

  // Close on escape key
  useEscapeKey(onClose, isOpen);

  // Close on click outside
  const refs = containerRef ? [dropdownRef, containerRef] : dropdownRef;
  useClickOutside(refs, onClose, isOpen);

  // Keyboard navigation
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (!isOpen) return;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        e.stopPropagation();
        setSelectedIndex(i => Math.min(i + 1, totalItems - 1));
        break;

      case 'ArrowUp':
        e.preventDefault();
        e.stopPropagation();
        setSelectedIndex(i => Math.max(i - 1, 0));
        break;

      case 'Enter':
        e.preventDefault();
        e.stopPropagation();
        
        if (selectedIndex < items.length) {
          const item = items[selectedIndex];
          if (!item.disabled) {
            onSelect(item.data);
          }
        } else if (showCreateOption && onCreate) {
          onCreate(createQuery);
        }
        break;
    }
  }, [isOpen, selectedIndex, totalItems, items, showCreateOption, onCreate, createQuery, onSelect]);

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  // Scroll selected item into view
  useEffect(() => {
    if (!dropdownRef.current) return;
    
    const selectedElement = dropdownRef.current.querySelector('.search-dropdown__item--highlighted');
    if (selectedElement) {
      selectedElement.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [selectedIndex]);

  if (!isOpen) return null;

  const renderContent = () => (
    <div 
      ref={dropdownRef}
      className={`search-dropdown ${className}`}
      style={{
        ...(position === 'fixed' && coordinates ? {
          position: 'fixed',
          top: coordinates.top,
          left: coordinates.left,
          width: coordinates.width,
        } : {}),
        maxHeight,
      }}
    >
      {isLoading ? (
        <div className="search-dropdown__loading">Loading...</div>
      ) : items.length === 0 && !showCreateOption ? (
        <div className="search-dropdown__empty">{emptyMessage}</div>
      ) : (
        <>
          <div className="search-dropdown__items">
            {items.map((item, index) => (
              <div
                key={item.key}
                className={`search-dropdown__item ${
                  index === selectedIndex ? 'search-dropdown__item--highlighted' : ''
                } ${item.disabled ? 'search-dropdown__item--disabled' : ''}`}
                onClick={() => !item.disabled && onSelect(item.data)}
                onMouseEnter={() => setSelectedIndex(index)}
              >
                {renderItem(item.data, index === selectedIndex)}
              </div>
            ))}
            
            {showCreateOption && (
              <div
                className={`search-dropdown__item search-dropdown__item--create ${
                  selectedIndex === items.length ? 'search-dropdown__item--highlighted' : ''
                }`}
                onClick={() => onCreate!(createQuery)}
                onMouseEnter={() => setSelectedIndex(items.length)}
              >
                {createText || `Create "${createQuery}"`}
              </div>
            )}
          </div>
          
          {footer && <div className="search-dropdown__footer">{footer}</div>}
        </>
      )}
    </div>
  );

  if (position === 'portal') {
    return createPortal(renderContent(), document.body);
  }

  return renderContent();
}
