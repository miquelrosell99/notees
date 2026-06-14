import { useEffect, useRef } from 'react';
import type { ShortcutContext, PaletteCommandMeta } from '@/stores/commandRegistry';
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
  /** Palette-specific metadata; presence makes the command appear in the palette */
  palette?: PaletteCommandMeta;
}

/**
 * Register a command in the Command Registry.
 * Automatically unregisters when the component unmounts.
 *
 * The command's `execute` function and metadata are kept in refs so that callers
 * can pass inline arrow functions / option objects without triggering a
 * re-register (and subsequent store update) on every render. Re-registering on
 * every render would cause an infinite update loop for any component that reads
 * from the registry (e.g. CommandPalette).
 */
export function useCommand(
  commandId: string,
  execute: () => void | boolean | Promise<void> | Promise<boolean>,
  options: UseCommandOptions = {}
) {
  const { enabled = true, context = 'global', label = commandId, icon, devOnly, requiresPage, palette } = options;
  const registerCommand = useCommandRegistry(state => state.registerCommand);
  const unregisterCommand = useCommandRegistry(state => state.unregisterCommand);

  const executeRef = useRef(execute);
  const optionsRef = useRef({ context, label, icon, devOnly, requiresPage, palette });

  useEffect(() => {
    executeRef.current = execute;
  }, [execute]);

  useEffect(() => {
    optionsRef.current = { context, label, icon, devOnly, requiresPage, palette };
  }, [context, label, icon, devOnly, requiresPage, palette]);

  useEffect(() => {
    if (!enabled) return;

    const command: Command = {
      id: commandId,
      get label() { return optionsRef.current.label ?? commandId; },
      get context() { return optionsRef.current.context ?? 'global'; },
      get icon() { return optionsRef.current.icon; },
      get devOnly() { return optionsRef.current.devOnly; },
      get requiresPage() { return optionsRef.current.requiresPage; },
      get palette() { return optionsRef.current.palette; },
      execute: () => executeRef.current(),
    };

    registerCommand(command);
    return () => unregisterCommand(commandId);
  }, [commandId, enabled, registerCommand, unregisterCommand]);
}
