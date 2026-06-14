/**
 * FilterPrefixPopup - Floating popup shown when user types ":" in the command palette
 *
 * Lists all available filter prefixes (class, uuid, is_page, etc.) and lets the
 * user pick one with arrow keys + Enter or with the mouse. Selecting a prefix
 * inserts it into the query, which in turn triggers that filter's value selection
 * UI (class picker popup, boolean options in results, etc.).
 */
import { useState, useRef, useEffect, useCallback } from 'react';
import { FILTER_PREFIXES } from '@/utils/searchFilters';
import { Icon } from '@/components/ui/icons';
import './FilterPrefixPopup.css';

export interface FilterPrefixPopupProps {
  /** Popup position relative to the viewport */
  position: { top: number; left: number };
  /** Called when a filter prefix is selected */
  onSelect: (prefix: string) => void;
  /** Called when the popup should be closed without selecting */
  onClose: () => void;
}

export function FilterPrefixPopup({ position, onSelect, onClose }: FilterPrefixPopupProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [adjustedPosition, setAdjustedPosition] = useState(position);
  const containerRef = useRef<HTMLDivElement>(null);

  const options = FILTER_PREFIXES;

  // Adjust popup position so it stays within the viewport after render
  useEffect(() => {
    if (!containerRef.current) return;

    const popupRect = containerRef.current.getBoundingClientRect();
    const padding = 8;
    let { top, left } = position;

    if (left + popupRect.width > window.innerWidth - padding) {
      left = window.innerWidth - popupRect.width - padding;
    }
    if (left < padding) {
      left = padding;
    }

    if (top + popupRect.height > window.innerHeight - padding) {
      const topAbove = position.top - popupRect.height - 24;
      if (topAbove >= padding) {
        top = topAbove;
      } else {
        top = window.innerHeight - popupRect.height - padding;
      }
    }

    if (top < padding) {
      top = padding;
    }

    setAdjustedPosition({ top, left });
  }, [position, options.length]);

  const handleSelect = useCallback((prefix: string) => {
    onSelect(prefix);
  }, [onSelect]);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (!options.length) return;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        e.stopPropagation();
        setSelectedIndex(i => Math.min(i + 1, options.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        e.stopPropagation();
        setSelectedIndex(i => Math.max(i - 1, 0));
        break;
      case 'Enter':
        e.preventDefault();
        e.stopPropagation();
        handleSelect(options[selectedIndex].prefix);
        break;
      case 'Escape':
      case 'Tab':
        e.preventDefault();
        e.stopPropagation();
        onClose();
        break;
    }
  }, [options, selectedIndex, handleSelect, onClose]);

  // Capture-phase listener so the popup handles navigation before the command palette input
  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [handleKeyDown]);

  // Close on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as globalThis.Node)) {
        onClose();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose]);

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-modal="true"
      aria-label="Filter options"
      className="filter-prefix-popup"
      style={{
        position: 'fixed',
        top: adjustedPosition.top,
        left: adjustedPosition.left,
        zIndex: 'var(--z-1000)',
      }}
      onMouseDownCapture={(e) => e.stopPropagation()}
      onClickCapture={(e) => e.stopPropagation()}
    >
      <div className="filter-prefix-popup__header">
        <span className="filter-prefix-popup__header-icon">:</span>
        <span>Filter by</span>
      </div>
      <div className="filter-prefix-popup__list" role="listbox">
        {options.map((fp, index) => (
          <button
            key={fp.prefix}
            type="button"
            role="option"
            aria-selected={selectedIndex === index}
            className={`filter-prefix-popup__item ${selectedIndex === index ? 'filter-prefix-popup__item--selected' : ''}`}
            onClick={() => handleSelect(fp.prefix)}
            onMouseEnter={() => setSelectedIndex(index)}
          >
            <span className="filter-prefix-popup__item-icon">
              <Icon path="mdi mdi-filter" size={0.7} />
            </span>
            <span className="filter-prefix-popup__item-content">
              <span className="filter-prefix-popup__item-name">{fp.prefix}:</span>
              <span className="filter-prefix-popup__item-description">{fp.description}</span>
            </span>
          </button>
        ))}
      </div>
      <div className="filter-prefix-popup__footer">
        <span className="filter-prefix-popup__hint">
          <kbd>↑</kbd><kbd>↓</kbd> navigate
        </span>
        <span className="filter-prefix-popup__hint">
          <kbd>↵</kbd> select
        </span>
      </div>
    </div>
  );
}
