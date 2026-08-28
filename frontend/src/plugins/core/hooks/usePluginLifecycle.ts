import { useMutation, useQueryClient } from '@tanstack/react-query';
import { pluginKeys } from '@/hooks/queryKeys';
import { rescanPlugins, uninstallPlugin, updatePlugin } from '../api';
import { pluginManager } from '../PluginManager';

export function useUninstallPlugin() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (pluginId: string) => uninstallPlugin(pluginId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: pluginKeys.list() });
    },
  });
}

export function useUpdatePlugin() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (pluginId: string) => updatePlugin(pluginId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: pluginKeys.list() });
    },
  });
}

/** Restartless enable/disable; applies to both backend routes and the frontend runtime. */
export function useSetPluginEnabled() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ pluginId, enabled }: { pluginId: string; enabled: boolean }) =>
      pluginManager.setPluginEnabled(pluginId, enabled),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: pluginKeys.list() });
    },
  });
}

/** Re-run backend discovery over the plugin folders and sync the frontend runtime. */
export function useRescanPlugins() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => rescanPlugins(),
    onSuccess: async () => {
      await pluginManager.refreshPlugins();
      queryClient.invalidateQueries({ queryKey: pluginKeys.list() });
    },
  });
}
