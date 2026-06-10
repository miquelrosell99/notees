/**
 * Stores module - exports all Zustand stores
 * 
 * Store Categories:
 * - Auth: useAuthStore
 * - UI State: useAppStore (display prefs), useNavigationStore, useModalStore, useSettingsStore, useFavoritesStore
 * - Notifications: useNotificationStore
 * - Feature Flags: useFeatureFlagStore
 * - Keyboard: useKeyboardStore
 *
 * ⚠️ PERFORMANCE WARNING:
 * Do NOT subscribe to node maps or collections directly.
 * Use selectors (e.g. useNavigationStore(s => s.openNode)) to avoid render cascades.
 */
export { useAuthStore } from '@/features/auth/stores/authStore';
export { usePresentationStore } from './presentationStore';
export { useModalStore } from './modalStore';
export { useNavigationStore } from './navigationStore';
export { useNavigationHistoryStore } from './navigationHistoryStore';
export { useAppStore, type ViewMode, type MainViewType, type NodeViewType, type SidebarNodeType, type RightSidebarContent, type ContentDisplayMode, type CardLayoutMode, type SidebarCard, type SidebarCardType } from './appStore';
export { 
  useSettingsStore, 
  applyTheme,
  applyAccentColor,
  formatDate,
  formatMonth,
  formatYear,
  DATE_FORMAT_OPTIONS,
  FIRST_DAY_OF_WEEK_OPTIONS,
  ACCENT_COLOR_OPTIONS,
  type ThemePreference, 
  type DateFormat,
  type DateFormatOption,
  type QuickAddDestination,
  type HashtagPasteMode,
  type DefaultView,
  type FirstDayOfWeek,
  type FirstDayOfWeekOption,
  type AccentColor,
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
  type ExportLinkStyle,
  type ExportThemeMode,
} from './exportSettingsStore';
// JSX components for feature flags are in components/core/FeatureFlag.tsx
export {
  useKeyboardStore,
  formatShortcutKey,
  matchesShortcut,
  SHORTCUT_IDS,
  type ShortcutDefinition,
  type ModifierKeys,
} from './keyboardStore';
export { type ShortcutContext } from './commandRegistry';
export { useWhiteboardStore } from './whiteboardStore';
export { useUndoStore } from './undoStore';
export { useClipboardStore, type ClipboardMode } from './clipboardStore';