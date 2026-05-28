/**
 * useKeyboardListNav Hook
 *
 * Lightweight keyboard list navigation primitive.
 * Handles ArrowUp/Down index clamping, Enter to select, Escape to close,
 * auto-reset on item count change, and scroll-into-view.
 *
 * Unlike useSearchableList, this hook does NOT manage query state —
 * components keep their own query/filter logic and just pass `totalItems`.
 */
import { useState, useCallback, useRef, useEffect, type RefObject } from 'react';

export interface UseKeyboardListNavOptions {
  /** Total number of selectable items */
  totalItems: number;
  /** Called when Enter is pressed; receives the current index */
  onSelect?: (index: number) => void;
  /** Called when Escape is pressed */
  onClose?: () => void;
  /** Whether the list is currently visible/active */
  isOpen?: boolean;
  /** Also call e.stopPropagation() on handled keys (for capture-phase listeners) */
  stopPropagation?: boolean;
}

export interface UseKeyboardListNavReturn {
  /** Currently highlighted index */
  selectedIndex: number;
  /** Manually set the index (e.g. onMouseEnter) */
  setSelectedIndex: (index: number | ((prev: number) => number)) => void;
  /** Ref for the scrollable list container — add data-selected="true" to the active item */
  listRef: RefObject<HTMLDivElement | null>;
  /** Attach to onKeyDown (React handler) */
  handleKeyDown: (e: React.KeyboardEvent) => void;
  /** Reset index to 0 */
  resetIndex: () => void;
}

export function useKeyboardListNav({
  totalItems,
  onSelect,
  onClose,
  isOpen = true,
  stopPropagation = false,
}: UseKeyboardListNavOptions): UseKeyboardListNavReturn {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // Reset selection when total items change (useLayoutEffect to sync before paint)
  useEffect(() => {
    if (isOpen) {
      setSelectedIndex(0);
    }
  }, [totalItems, isOpen]);

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return;
    const selectedEl = listRef.current.querySelector('[data-selected="true"]');
    if (selectedEl) {
      selectedEl.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const stop = () => {
        e.preventDefault();
        if (stopPropagation) e.stopPropagation();
      };

      switch (e.key) {
        case 'ArrowDown':
          stop();
          setSelectedIndex((prev) => Math.min(prev + 1, totalItems - 1));
          break;
        case 'ArrowUp':
          stop();
          setSelectedIndex((prev) => Math.max(prev - 1, 0));
          break;
        case 'Enter':
          stop();
          if (onSelect && totalItems > 0) {
            onSelect(selectedIndex);
          }
          break;
        case 'Escape':
          stop();
          onClose?.();
          break;
      }
    },
    [totalItems, selectedIndex, onSelect, onClose, stopPropagation],
  );

  const resetIndex = useCallback(() => setSelectedIndex(0), []);

  return {
    selectedIndex,
    setSelectedIndex,
    listRef,
    handleKeyDown,
    resetIndex,
  };
}

export default useKeyboardListNav;
