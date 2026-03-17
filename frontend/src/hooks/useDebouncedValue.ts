import { useState, useEffect } from 'react';

/**
 * Debounces a value by the given delay in milliseconds.
 * Returns the stable/delayed value, not the latest one.
 *
 * @example
 * const debouncedQuery = useDebouncedValue(query, 200);
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const handle = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(handle);
  }, [value, delayMs]);

  return debounced;
}
