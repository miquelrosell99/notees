import { useRef, useCallback, useEffect, useState } from 'react';

export interface CanvasViewportState {
  panX: number;
  panY: number;
  scale: number;
}

interface UseCanvasViewportOptions {
  minScale?: number;
  maxScale?: number;
  wheelZoom?: boolean;
  panButton?: 'left' | 'middle';
}

/**
 * Headless hook for canvas pan/zoom interactions.
 * Supports wheel zoom and drag-to-pan.
 *
 * Usage:
 *   const { state, handlers, toWorld, toScreen } = useCanvasViewport({ minScale: 0.1, maxScale: 5 });
 *   <canvas onWheel={handlers.onWheel} onMouseDown={handlers.onMouseDown} />
 */
export function useCanvasViewport(options: UseCanvasViewportOptions = {}) {
  const { minScale = 0.1, maxScale = 5, wheelZoom = true, panButton = 'left' } = options;

  const [state, setState] = useState<CanvasViewportState>({ panX: 0, panY: 0, scale: 1 });
  const stateRef = useRef(state);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const isPanningRef = useRef(false);
  const panStartRef = useRef({ x: 0, y: 0, panX: 0, panY: 0 });

  const clampScale = useCallback(
    (s: number) => Math.max(minScale, Math.min(maxScale, s)),
    [minScale, maxScale]
  );

  const setViewport = useCallback((updater: (prev: CanvasViewportState) => CanvasViewportState) => {
    setState((prev) => {
      const next = updater(prev);
      return { ...next, scale: clampScale(next.scale) };
    });
  }, [clampScale]);

  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      if (!wheelZoom) return;
      e.preventDefault();

      const rect = (e.target as HTMLElement).getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9;
      const newScale = clampScale(stateRef.current.scale * zoomFactor);

      // Zoom towards mouse pointer
      const scaleRatio = newScale / stateRef.current.scale;
      const newPanX = mouseX - (mouseX - stateRef.current.panX) * scaleRatio;
      const newPanY = mouseY - (mouseY - stateRef.current.panY) * scaleRatio;

      setState({ panX: newPanX, panY: newPanY, scale: newScale });
    },
    [wheelZoom, clampScale]
  );

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      const expectedButton = panButton === 'middle' ? 1 : 0;
      if (e.button !== expectedButton) return;
      e.preventDefault();
      isPanningRef.current = true;
      panStartRef.current = { x: e.clientX, y: e.clientY, panX: stateRef.current.panX, panY: stateRef.current.panY };
    },
    [panButton]
  );

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isPanningRef.current) return;
    const dx = e.clientX - panStartRef.current.x;
    const dy = e.clientY - panStartRef.current.y;
    setState({
      panX: panStartRef.current.panX + dx,
      panY: panStartRef.current.panY + dy,
      scale: stateRef.current.scale,
    });
  }, []);

  const onMouseUp = useCallback(() => {
    isPanningRef.current = false;
  }, []);

  const onMouseLeave = useCallback(() => {
    isPanningRef.current = false;
  }, []);

  // Global mouse move/up to handle panning even when cursor leaves the canvas
  useEffect(() => {
    const handleGlobalMove = (e: MouseEvent) => {
      if (!isPanningRef.current) return;
      const dx = e.clientX - panStartRef.current.x;
      const dy = e.clientY - panStartRef.current.y;
      setState({
        panX: panStartRef.current.panX + dx,
        panY: panStartRef.current.panY + dy,
        scale: stateRef.current.scale,
      });
    };
    const handleGlobalUp = () => {
      isPanningRef.current = false;
    };

    window.addEventListener('mousemove', handleGlobalMove);
    window.addEventListener('mouseup', handleGlobalUp);
    return () => {
      window.removeEventListener('mousemove', handleGlobalMove);
      window.removeEventListener('mouseup', handleGlobalUp);
    };
  }, []);

  const toWorld = useCallback(
    (screenX: number, screenY: number) => ({
      x: (screenX - state.panX) / state.scale,
      y: (screenY - state.panY) / state.scale,
    }),
    [state]
  );

  const toScreen = useCallback(
    (worldX: number, worldY: number) => ({
      x: worldX * state.scale + state.panX,
      y: worldY * state.scale + state.panY,
    }),
    [state]
  );

  return {
    state,
    setViewport,
    handlers: { onWheel, onMouseDown, onMouseMove, onMouseUp, onMouseLeave },
    toWorld,
    toScreen,
  };
}
