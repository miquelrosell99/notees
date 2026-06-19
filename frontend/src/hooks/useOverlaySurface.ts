import { useEffect, useRef } from 'react';
import { useInputContext, type OverlaySurfaceType } from '@/stores/inputContext';
import { useCallbackRef } from './useCallbackRef';

interface UseOverlaySurfaceOptions {
  /** Whether this surface should currently be registered on the stack. */
  enabled: boolean;
  /** Surface kind, used for the modal/popup counters. */
  type: OverlaySurfaceType;
  /** Called when the stack decides this surface should close. */
  onClose: () => void;
  /**
   * Called before close when Escape is pressed.
   * Return true to consume Escape without closing (e.g. for nested sub-states).
   */
  onEscape?: () => boolean | void;
  /** Optional explicit id; one is generated if omitted. */
  id?: string;
}

function generateSurfaceId(): string {
  return `surface-hook-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

/**
 * Register an overlay surface with the global input context stack.
 *
 * This lets a single global Escape handler close surfaces in LIFO order,
 * regardless of where DOM focus currently is.
 */
export function useOverlaySurface(options: UseOverlaySurfaceOptions): string {
  const idRef = useRef(options.id ?? generateSurfaceId());
  const onCloseRef = useCallbackRef(options.onClose);
  const onEscapeRef = useCallbackRef(options.onEscape ?? (() => false as boolean | void));

  useEffect(() => {
    if (!options.enabled) return;

    const id = idRef.current;
    const { pushSurface, removeSurface } = useInputContext.getState();

    pushSurface({
      id,
      type: options.type,
      close: () => onCloseRef(),
      onEscape: () => onEscapeRef(),
    });

    return () => removeSurface(id);
  }, [options.enabled, options.type, onCloseRef, onEscapeRef]);

  return idRef.current;
}
