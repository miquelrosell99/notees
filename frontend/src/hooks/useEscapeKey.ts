import { useEffect } from 'react';

/**
 * Hook to detect Escape key presses
 * 
 * @param handler - Callback to invoke when Escape is pressed
 * @param enabled - Whether the listener is active (default: true)
 */
export function useEscapeKey(handler: () => void, enabled = true) {
  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        handler();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handler, enabled]);
}
