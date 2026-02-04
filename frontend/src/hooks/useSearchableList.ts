/**
 * useSearchableList Hook
 * 
 * A reusable hook for searchable lists with keyboard navigation.
 * Used in CommandPalette, NodePicker, PropertySuggestionPopup, etc.
 * 
 * Features:
 * - Search query state management
 * - Arrow key navigation (up/down)
 * - Enter to select
 * - Escape to close
 * - Auto-reset selection when results change
 * - Scroll selected item into view
 */
import { useState, useCallback, useRef, useEffect, useLayoutEffect, type RefObject } from 'react';

export interface UseSearchableListOptions {
  /** Total number of items in the list */
  totalItems: number;
  /** Callback when an item is selected (Enter key) */
  onSelect?: (index: number) => void;
  /** Callback when the list should close (Escape key) */
  onClose?: () => void;
  /** Whether the list is currently open/active */
  isOpen?: boolean;
  /** Initial search query */
  initialQuery?: string;
}

export interface UseSearchableListReturn {
  /** Current search query */
  query: string;
  /** Set the search query */
  setQuery: (query: string) => void;
  /** Currently selected index */
  selectedIndex: number;
  /** Set the selected index */
  setSelectedIndex: (index: number | ((prev: number) => number)) => void;
  /** Ref for the search input */
  inputRef: RefObject<HTMLInputElement | null>;
  /** Ref for the list container (for scroll into view) */
  listRef: RefObject<HTMLDivElement | null>;
  /** Keyboard event handler for the input */
  handleKeyDown: (e: React.KeyboardEvent) => void;
  /** Reset the state (query and selection) */
  reset: () => void;
}

/**
 * Hook for managing searchable list state and keyboard navigation
 */
export function useSearchableList({
  totalItems,
  onSelect,
  onClose,
  isOpen = true,
  initialQuery = '',
}: UseSearchableListOptions): UseSearchableListReturn {
  const [query, setQuery] = useState(initialQuery);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Reset selection when total items change
  // Using useLayoutEffect to sync before paint
  useLayoutEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Reset selection when list changes in useLayoutEffect
    setSelectedIndex(0);
  }, [totalItems]);

  // Focus input when opened
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return;
    const selectedEl = listRef.current.querySelector('[data-selected="true"]');
    if (selectedEl) {
      selectedEl.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  // Handle keyboard navigation
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setSelectedIndex((prev) => Math.min(prev + 1, totalItems - 1));
          break;

        case 'ArrowUp':
          e.preventDefault();
          setSelectedIndex((prev) => Math.max(prev - 1, 0));
          break;

        case 'Enter':
          e.preventDefault();
          if (onSelect && totalItems > 0) {
            onSelect(selectedIndex);
          }
          break;

        case 'Escape':
          e.preventDefault();
          onClose?.();
          break;
      }
    },
    [totalItems, selectedIndex, onSelect, onClose]
  );

  // Reset function
  const reset = useCallback(() => {
    setQuery(initialQuery);
    setSelectedIndex(0);
  }, [initialQuery]);

  return {
    query,
    setQuery,
    selectedIndex,
    setSelectedIndex,
    inputRef,
    listRef,
    handleKeyDown,
    reset,
  };
}

export default useSearchableList;
