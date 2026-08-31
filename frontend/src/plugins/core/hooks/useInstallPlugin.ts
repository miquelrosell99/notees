import { useMutation, useQueryClient } from '@tanstack/react-query';
import { pluginKeys } from '@/hooks/queryKeys';
import { installPlugin, installPluginZip } from '../api';
import { pluginManager } from '../PluginManager';

export function useInstallPlugin() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: installPlugin,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: pluginKeys.list() });
    },
  });
}

export function useInstallPluginZip() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (file: File) => installPluginZip(file),
    onSuccess: async () => {
      // The backend loaded and mounted the plugin; sync the frontend runtime.
      await pluginManager.refreshPlugins();
      queryClient.invalidateQueries({ queryKey: pluginKeys.list() });
    },
  });
}
