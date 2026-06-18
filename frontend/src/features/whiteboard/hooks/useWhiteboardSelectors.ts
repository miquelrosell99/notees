import { useWhiteboardStore } from '@/features/whiteboard/stores/whiteboardStore';
import { useShallow } from 'zustand/react/shallow';

export const useGridSettings = () =>
  useWhiteboardStore(
    useShallow((s) => ({
      gridSnap: s.gridSnap,
      gridSize: s.gridSize,
    })),
  );

export const useGridToggles = () =>
  useWhiteboardStore(
    useShallow((s) => ({
      toggleGrid: s.toggleGrid,
      toggleSnap: s.toggleSnap,
    })),
  );

export const useWhiteboardToolbarSettings = () =>
  useWhiteboardStore(
    useShallow((s) => ({
      gridVisible: s.gridVisible,
      gridSnap: s.gridSnap,
      minimapVisible: s.minimapVisible,
      toggleMinimap: s.toggleMinimap,
    })),
  );

export const useWhiteboardViewSettings = () =>
  useWhiteboardStore(
    useShallow((s) => ({
      gridVisible: s.gridVisible,
      gridSize: s.gridSize,
      minimapVisible: s.minimapVisible,
    })),
  );
