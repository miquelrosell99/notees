/**
 * Registers global commands provided by the plugin system itself.
 */

import { useCommand } from '@/hooks/useCommand';
import { COMMAND_IDS } from '@/stores/commandRegistry';
import { useCapabilities } from '@/config/capabilities';

interface PluginCommandRegistrationsProps {
  onOpenPluginManager: () => void;
}

export function PluginCommandRegistrations({ onOpenPluginManager }: PluginCommandRegistrationsProps) {
  // Plugin manifests come from the backend; the manager entry is hidden in
  // local mode (local-first split, Task 4).
  const capabilities = useCapabilities();
  useCommand(
    COMMAND_IDS.PLUGIN_MANAGER,
    onOpenPluginManager,
    {
      label: 'Open Plugin Manager',
      icon: 'mdi-puzzle-outline',
      context: 'global',
      enabled: capabilities.plugins,
      palette: { category: 'tools' },
    },
  );

  return null;
}
