import { useRef, useEffect, useCallback } from 'react';

/**
 * Returns a stable callback that always forwards to the latest
 * implementation without triggering re-registrations or re-renders.
 */
export function useCallbackRef<T extends (...args: unknown[]) => unknown>(callback: T): T {
  const callbackRef = useRef(callback);

  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  return useCallback((...args: Parameters<T>) => callbackRef.current(...args), []) as T;
}
