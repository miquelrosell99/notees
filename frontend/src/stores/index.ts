/**
 * Stores module - exports all Zustand stores
 * 
 * Store Categories:
 * - Auth: useAuthStore
 * - UI State: useAppStore, useSettingsStore, useFavoritesStore
 * - Notifications: useNotificationStore
 * - Feature Flags: useFeatureFlagStore
 * - Keyboard: useKeyboardStore
 * 
 * ⚠️ PERFORMANCE WARNING:
 * Do NOT subscribe to node maps or collections directly.
 * Use selectors from './selectors' only. Direct subscriptions cause render cascades.
 */
export { useAuthStore } from './authStore';
export { useAppStore, type ViewMode, type MainViewType, type NodeViewType, type SidebarNodeType, type RightSidebarContent, type ContentDisplayMode, type CardLayoutMode, type SidebarCard, type SidebarCardType } from './appStore';
export { 
  useSettingsStore, 
  applyTheme,
  formatDate,
  formatMonth,
  formatYear,
  DATE_FORMAT_OPTIONS,
  FIRST_DAY_OF_WEEK_OPTIONS,
  type ThemePreference, 
  type DateFormat,
  type DateFormatOption,
  type QuickAddDestination,
  type HashtagPasteMode,
  type DefaultView,
  type FirstDayOfWeek,
  type FirstDayOfWeekOption,
} from './settingsStore';
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
  useFeatureFlagStore,
  useFeatureFlag,
  useFeatureFlagWithDefinition,
  useAllFeatureFlags,
  DEFAULT_FLAGS,
  type FeatureFlagName,
  type FeatureFlagDefinition,
} from './featureFlagStore';
export {
  useExportSettingsStore,
  type ExportFormat,
  type ExportLayout,
  type ExportStyle,
  type ExportProperties,
  type ExportDensity,
  type ExportNumbering,
  type ExportMeasure,
  type ExportDoctype,
} from './exportSettingsStore';
// JSX components for feature flags are in components/core/FeatureFlag.tsx
export {
  useKeyboardStore,
  formatShortcutKey,
  matchesShortcut,
  SHORTCUT_IDS,
  type ShortcutContext,
  type ShortcutDefinition,
  type ModifierKeys,
} from './keyboardStore';export { useWhiteboardStore } from './whiteboardStore';