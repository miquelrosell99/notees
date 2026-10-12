/**
 * useMediaQuery — the reactive media-query seam. Environments without
 * matchMedia (jsdom) read as NOT matching — wide-layout defaults hold in
 * tests. The listener keeps the value live across resizes and orientation
 * changes; display-only consumption (the narrow-viewport search fold,
 * owner 2026-10-12), never semantic state.
 */

import { useEffect, useState } from "react";

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(query).matches
      : false,
  );

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}
