import { useState, useEffect } from 'react';

function getMobileBreakpoint(): number {
  if (typeof window === 'undefined') return 768;
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue('--breakpoint-tablet')
    .trim();
  const value = parseInt(raw, 10);
  return Number.isFinite(value) ? value : 768;
}

/**
 * Returns true when the viewport is at or below the mobile breakpoint.
 * Reads the breakpoint from `--breakpoint-tablet` in `variables.css` so
 * responsive logic stays in sync with the design tokens.
 */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(
    () => window.matchMedia(`(max-width: ${getMobileBreakpoint()}px)`).matches
  );

  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${getMobileBreakpoint()}px)`);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, []);

  return isMobile;
}
