/**
 * Keyboard Shortcut Helpers
 * 
 * Constants and utility functions for keyboard shortcuts.
 * Separated from hooks to enable Fast Refresh.
 */

export {
  SHORTCUT_IDS,
  formatShortcutKey,
  processKeyboardEvent,
} from '@/stores/keyboardStore';
export { type ShortcutContext } from '@/stores/commandRegistry';
