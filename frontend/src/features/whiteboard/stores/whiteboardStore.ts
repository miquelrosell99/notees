/**
 * Global whiteboard settings store (Zustand + localStorage persistence).
 *
 * Grid / snap preferences are shared across ALL whiteboards — they're a user
 * preference, not per-document state.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface WhiteboardStoreState {
  /** Whether the dot grid is visible on the canvas */
  gridVisible: boolean;
  /** Whether elements snap to the grid when moved/resized */
  gridSnap: boolean;
  /** Grid cell size in world-space pixels */
  gridSize: number;
  /** Whether the minimap overlay is visible */
  minimapVisible: boolean;

  toggleGrid: () => void;
  toggleSnap: () => void;
  toggleMinimap: () => void;
}

export const useWhiteboardStore = create<WhiteboardStoreState>()(
  persist(
    (set) => ({
      gridVisible: true,
      gridSnap: true,
      gridSize: 20,
      minimapVisible: true,

      toggleGrid: () => set((s) => ({ gridVisible: !s.gridVisible })),
      toggleSnap: () => set((s) => ({ gridSnap: !s.gridSnap })),
      toggleMinimap: () => set((s) => ({ minimapVisible: !s.minimapVisible })),
    }),
    { name: 'notees-whiteboard-settings' }
  )
);
