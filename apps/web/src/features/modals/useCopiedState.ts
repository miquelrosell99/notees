/**
 * useCopiedState — transient "copied" flag with an automatic reset (drives
 * the export modal's Copy button). Lives in its own module: the
 * old overlayHooks stack it came from was deleted — every other behavior in
 * that file (overlay stack / focus trap / click-outside / media queries)
 * had a live kit implementation in components/ui/overlay-hooks.ts, and
 * this was the only survivor.
 */

import { useCallback, useEffect, useRef, useState } from "react";

/** Transient "copied" flag with an automatic reset (drives the Copy button). */
export function useCopiedState(resetMs = 2000): [boolean, () => void] {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const triggerCopy = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setCopied(true);
    timeoutRef.current = setTimeout(() => {
      setCopied(false);
      timeoutRef.current = null;
    }, resetMs);
  }, [resetMs]);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  return [copied, triggerCopy];
}
