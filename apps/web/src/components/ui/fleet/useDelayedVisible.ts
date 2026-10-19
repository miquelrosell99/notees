/**
 * useDelayedVisible — the loading-timing rule (<300ms nothing): returns true
 * only after `active` has been continuously true for `delayMs`, and false
 * the moment `active` goes false. Inline spinners ride this so a fast async
 * action never flashes a spinner; the 2s+ boundary (skeleton instead of
 * spinner) is a caller choice, not this hook's.
 */

import { useEffect, useState } from 'react';

export function useDelayedVisible(active: boolean, delayMs = 300): boolean {
  const [elapsed, setElapsed] = useState(false);
  useEffect(() => {
    if (!active) {
      setElapsed(false);
      return;
    }
    const id = window.setTimeout(() => setElapsed(true), delayMs);
    return () => window.clearTimeout(id);
  }, [active, delayMs]);
  return active && elapsed;
}
