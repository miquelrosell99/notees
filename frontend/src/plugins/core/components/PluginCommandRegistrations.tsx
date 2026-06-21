/**
 * Registers global commands provided by the plugin system itself.
 */

import { useCommand } from '@/hooks/useCommand';
import { COMMAND_IDS } from '@/stores/commandRegistry';

interface PluginCommandRegistrationsProps {
  onOpenPluginManager: () => void;
}

export function PluginCommandRegistrations({ onOpenPluginManager }: PluginCommandRegistrationsProps) {
  useCommand(
    COMMAND_IDS.PLUGIN_MANAGER,
    onOpenPluginManager,
    {
      label: 'Open Plugin Manager',
      icon: 'mdi-puzzle-outline',
      context: 'global',
      palette: { category: 'tools' },
    },
  );

  return null;
}
