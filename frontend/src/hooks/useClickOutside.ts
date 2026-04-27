import { useEffect } from 'react';
import type { RefObject } from 'react';

/**
 * Hook to detect clicks outside one or more elements
 * 
 * @param refs - Single ref or array of refs to exclude from "outside" detection
 * @param handler - Callback to invoke when clicking outside
 * @param enabled - Whether the listener is active (default: true)
 */
export function useClickOutside(
  refs: RefObject<HTMLElement | null> | RefObject<HTMLElement | null>[],
  handler: () => void,
  enabled = true
) {
  useEffect(() => {
    if (!enabled) return;

    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      const refArray = Array.isArray(refs) ? refs : [refs];

      // Check if click is outside all provided refs
      const isOutside = refArray.every(
        (ref) => ref.current && !ref.current.contains(target)
      );

      if (isOutside) {
        handler();
      }
    };

    // Use mousedown instead of click for better UX (matches existing patterns)
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [refs, handler, enabled]);
}
