import { useState, useCallback, useRef, useEffect } from 'react';

/**
 * Hook for a transient "copied" state with automatic reset.
 *
 * @param resetMs - How long to stay in the "copied" state before resetting (default 2000ms)
 * @returns [copied, triggerCopy]
 *
 * @example
 * const [copied, triggerCopy] = useCopiedState();
 * <button onClick={triggerCopy}>Copy</button>
 * {copied && <span>Copied!</span>}
 */
export function useCopiedState(resetMs = 2000): [boolean, () => void] {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const triggerCopy = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
    setCopied(true);
    timeoutRef.current = setTimeout(() => {
      setCopied(false);
      timeoutRef.current = null;
    }, resetMs);
  }, [resetMs]);

  // Clear any pending reset timer on unmount to avoid setState after unmount
  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, []);

  return [copied, triggerCopy];
}
