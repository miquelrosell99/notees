/**
 * useKeyboardShortcuts - Hook for registering keyboard shortcuts
 *
 * Provides a clean API for components to register keyboard commands.
 * All commands route through the Command Registry.
 *
 * Usage:
 * ```tsx
 * function MyComponent() {
 *   useCommand(COMMAND_IDS.COMMAND_PALETTE, () => {
 *     openCommandPalette();
 *   }, { label: 'Open Command Palette' });
 * }
 * ```
 */
import { useEffect } from 'react';
import {
  useKeyboardStore,
  type ShortcutContext,
} from '@/stores/keyboardStore';
import { useCommandRegistry, type Command } from '@/stores/commandRegistry';
import { processKeyboardEvent } from '@/stores/keyboardStore';

// Re-export for convenience
export { SHORTCUT_IDS, formatShortcutKey } from '@/stores/keyboardStore';
export { COMMAND_IDS } from '@/stores/commandRegistry';

interface UseCommandOptions {
  /** Whether the command is currently enabled (default: true) */
  enabled?: boolean;
  /** Context where this command is active */
  context?: ShortcutContext;
  /** Human-readable label for Command Palette */
  label?: string;
  /** Icon name for Command Palette */
  icon?: string;
  /** Whether this command is dev-only */
  devOnly?: boolean;
  /** Whether this command requires an active page */
  requiresPage?: boolean;
}

/**
 * Register a command in the Command Registry.
 * Automatically unregisters when the component unmounts.
 */
export function useCommand(
  commandId: string,
  execute: () => void | boolean,
  options: UseCommandOptions = {}
) {
  const { enabled = true, context = 'global', label = commandId, icon, devOnly, requiresPage } = options;
  const registerCommand = useCommandRegistry(state => state.registerCommand);
  const unregisterCommand = useCommandRegistry(state => state.unregisterCommand);

  useEffect(() => {
    if (!enabled) return;

    const command: Command = {
      id: commandId,
      label,
      context,
      icon,
      devOnly,
      requiresPage,
      execute,
    };

    registerCommand(command);
    return () => unregisterCommand(commandId);
  }, [commandId, execute, enabled, context, label, icon, devOnly, requiresPage, registerCommand, unregisterCommand]);
}

/**
 * Legacy hook — registers a keyboard shortcut handler.
 * Prefer useCommand() for new code.
 */
interface UseKeyboardShortcutOptions {
  enabled?: boolean;
  priority?: number;
}

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

/**
 * Activate/deactivate a shortcut context
 */
export function useShortcutContext(context: ShortcutContext, active: boolean = true) {
  const activateContext = useKeyboardStore(state => state.activateContext);
  const deactivateContext = useKeyboardStore(state => state.deactivateContext);

  useEffect(() => {
    if (active) {
      activateContext(context);
      return () => deactivateContext(context);
    }
  }, [context, active, activateContext, deactivateContext]);
}

/**
 * Get the display string for a shortcut
 */
export function useShortcutDisplay(shortcutId: string): string {
  return useKeyboardStore(state => state.formatShortcut(shortcutId));
}

/**
 * Get all shortcuts for a context (useful for help dialogs)
 */
export function useShortcutsForContext(context: ShortcutContext) {
  return useKeyboardStore(state =>
    state.getAllShortcuts().filter(s => s.context === context)
  );
}

/**
 * Hook to set up global keyboard event listener.
 * Should be used once at the app root level.
 *
 * Intercepts ALL modifier shortcuts at the capture phase so the browser
 * never sees shortcuts the app claims (Ctrl+F, Ctrl+K, Ctrl+N, etc.).
 */
export function useGlobalKeyboardListener() {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA';
      const isContentEditable = target.isContentEditable;

      // Allow modifier shortcuts (Ctrl/Cmd) even in text editing contexts.
      // Non-modifier keys in inputs/contenteditable are left alone so typing works.
      const isModifierShortcut = event.ctrlKey || event.metaKey;

      if ((isInput || isContentEditable) && !isModifierShortcut) {
        return;
      }

      // Always process modifier shortcuts — processKeyboardEvent will decide
      // whether to consume them based on active contexts and registered commands.
      processKeyboardEvent(event);
    };

    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, []);
}

/**
 * Provider component that sets up global keyboard handling
 */
export function KeyboardShortcutsProvider({ children }: { children: React.ReactNode }) {
  useGlobalKeyboardListener();
  return <>{children}</>;
}

export default useKeyboardShortcut;
