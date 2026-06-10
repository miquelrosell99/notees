import { useEffect } from 'react';
import type { ShortcutContext } from '@/stores/commandRegistry';
import { useCommandRegistry, type Command } from '@/stores/commandRegistry';

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
