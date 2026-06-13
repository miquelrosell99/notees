/**
 * useReducedMotion hook
 *
 * Returns true when the user prefers reduced motion, as reported by
 * `prefers-reduced-motion: reduce`. Updates automatically if the preference
 * changes (e.g. on OS accessibility settings changes).
 */
import { useEffect, useState } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia(QUERY).matches;
  });

  useEffect(() => {
    const mql = window.matchMedia(QUERY);
    const handleChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mql.addEventListener('change', handleChange);
    return () => mql.removeEventListener('change', handleChange);
  }, []);

  return reduced;
}
