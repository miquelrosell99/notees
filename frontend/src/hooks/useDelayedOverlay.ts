import { useEffect, useRef, useState } from 'react';

type OverlayPhase = 'hidden' | 'delaying' | 'visible' | 'hiding';

interface UseDelayedOverlayResult {
  /** Whether the overlay should be rendered at all */
  isRendered: boolean;
  /** Whether the overlay should be visually opaque */
  isVisible: boolean;
}

/**
 * Manages a delayed appear / delayed disappear overlay.
 *
 * - When `active` becomes true, the overlay is mounted immediately but stays
 *   invisible for `appearDelay` ms before fading in.
 * - When `active` becomes false, the overlay fades out over `disappearDuration`
 *   ms and is then unmounted.
 * - If `active` flips back on while fading out, it becomes visible again
 *   without waiting for the appear delay.
 */
export function useDelayedOverlay(
  active: boolean,
  appearDelay: number,
  disappearDuration: number,
): UseDelayedOverlayResult {
  const [phase, setPhase] = useState<OverlayPhase>('hidden');
  const timersRef = useRef<{ show?: number; hide?: number }>({});

  useEffect(() => {
    const clearTimers = () => {
      if (timersRef.current.show) {
        clearTimeout(timersRef.current.show);
        timersRef.current.show = undefined;
      }
      if (timersRef.current.hide) {
        clearTimeout(timersRef.current.hide);
        timersRef.current.hide = undefined;
      }
    };

    if (active) {
      setPhase((current) => {
        if (current === 'hidden') {
          timersRef.current.show = window.setTimeout(() => {
            setPhase((p) => (p === 'delaying' ? 'visible' : p));
          }, appearDelay);
          return 'delaying';
        }
        if (current === 'hiding') {
          timersRef.current.hide = undefined;
          return 'visible';
        }
        return current;
      });
    } else {
      setPhase((current) => {
        if (current === 'delaying') {
          clearTimers();
          return 'hidden';
        }
        if (current === 'visible') {
          timersRef.current.hide = window.setTimeout(() => {
            setPhase((p) => (p === 'hiding' ? 'hidden' : p));
          }, disappearDuration);
          return 'hiding';
        }
        return current;
      });
    }

    return clearTimers;
  }, [active, appearDelay, disappearDuration]);

  return {
    isRendered: phase !== 'hidden',
    isVisible: phase === 'visible',
  };
}
