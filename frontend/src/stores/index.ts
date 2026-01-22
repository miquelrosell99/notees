/**
 * Stores module - exports all Zustand stores
 * 
 * ⚠️ PERFORMANCE WARNING:
 * Do NOT subscribe to node maps or collections directly (e.g., state.nodes, state.selectedBlocks).
 * Use selectors from './selectors' only. Direct subscriptions cause render cascades.
 * 
 * ✅ CORRECT: useIsBlockSelected(blockId)
 * ❌ WRONG:  useBlockSelectionStore(state => state.selectedBlocks.has(blockId))
 */
export { useAuthStore } from './authStore';
export { useNodesStore, type ViewMode, type MainViewType, type NodeViewType, type SidebarNodeType, type RightSidebarContent, type ContentDisplayMode, type CardLayoutMode, type SidebarCard, type SidebarCardType } from './nodesStore';
export { 
  useSettingsStore, 
  applyTheme,
  formatDate,
  formatMonth,
  DATE_FORMAT_OPTIONS,
  type ThemePreference, 
  type DateFormat,
  type DateFormatOption,
  type QuickAddDestination,
} from './settingsStore';
export { 
  useBlockSelectionStore,
  type SelectionMode,
  type DragState,
  type BoxSelectState,
} from './blockSelectionStore';
export {
  useFavoritesStore,
  type FavoriteItem,
  type RecentItem,
} from './favoritesStore';

// Performance-optimized selectors
export * from './selectors';
