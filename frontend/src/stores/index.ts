/**
 * Stores module - exports all Zustand stores
 * 
 * Store Categories:
 * - Auth: useAuthStore
 * - UI State: useNodesStore, useSettingsStore, useFavoritesStore
 * - Selection: useBlockSelectionStore
 * - History: useHistoryStore
 * - Commands: useBlockCommandStore
 * - Notifications: useNotificationStore
 * - Feature Flags: useFeatureFlagStore
 * - Keyboard: useKeyboardStore
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
  type EditorSelection,
  type OperationQueueEntry,
} from './blockSelectionStore';
export {
  useHistoryStore,
  useHistoryActions,
  useHistoryAvailability,
  type HistoryEntry,
  type HistoryOperationType,
  type NodeSnapshot,
} from './historyStore';
export {
  useFavoritesStore,
  type FavoriteItem,
  type RecentItem,
} from './favoritesStore';
export {
  useNotificationStore,
  useNotifications,
  type Notification,
  type NotificationType,
} from './notificationStore';
export {
  useBlockCommandStore,
  useBlockCommands,
  useRegisterBlockCommands,
  type BlockCommandType,
  type CommandContext,
  type CommandResult,
  type BlockCommand,
  type CommandDefinition,
} from './blockCommandStore';
export {
  useFeatureFlagStore,
  useFeatureFlag,
  useFeatureFlagWithDefinition,
  useAllFeatureFlags,
  DEFAULT_FLAGS,
  type FeatureFlagName,
  type FeatureFlagDefinition,
} from './featureFlagStore';
// JSX components for feature flags are in components/core/FeatureFlag.tsx
export {
  useKeyboardStore,
  formatShortcutKey,
  matchesShortcut,
  SHORTCUT_IDS,
  type ShortcutContext,
  type ShortcutDefinition,
  type ModifierKeys,
} from './keyboardStore';

// Performance-optimized selectors
export * from './selectors';
