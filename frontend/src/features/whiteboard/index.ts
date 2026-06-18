/**
 * Public surface of the whiteboard feature.
 *
 * Cross-feature imports should prefer `@/features/whiteboard` (this barrel)
 * over reaching into internal subdirectories.
 */

// Page listing all whiteboards
export { WhiteboardsView } from './pages/WhiteboardsView';

// Single-whiteboard canvas view
export { WhiteboardView } from './components/WhiteboardView';

// Core whiteboard hook and derived selectors
export { useWhiteboard, type UseWhiteboardReturn } from './hooks/useWhiteboard';
export {
  useGridSettings,
  useGridToggles,
  useWhiteboardToolbarSettings,
  useWhiteboardViewSettings,
} from './hooks/useWhiteboardSelectors';

// Global whiteboard settings store
export { useWhiteboardStore } from './stores/whiteboardStore';

// Type definitions and constants
export * from './types/whiteboard';
