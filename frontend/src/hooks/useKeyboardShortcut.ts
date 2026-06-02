import { useEffect } from 'react';
import { useKeyboardStore } from '@/stores/keyboardStore';

interface UseKeyboardShortcutOptions {
  enabled?: boolean;
  priority?: number;
}

/**
 * Legacy hook — registers a keyboard shortcut handler.
 * Prefer useCommand() for new code.
 */
export function useKeyboardShortcut(
  shortcutId: string,
  handler: () => void | boolean,
  options: UseKeyboardShortcutOptions = {}
) {
  const { enabled = true, priority = 0 } = options;
  const registerHandler = useKeyboardStore(state => state.registerHandler);

  useEffect(() => {
    if (!enabled) return;
    return registerHandler(shortcutId, handler, priority);
  }, [shortcutId, handler, enabled, priority, registerHandler]);
}
