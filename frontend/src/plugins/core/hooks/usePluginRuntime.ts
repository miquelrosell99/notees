import { useMutation, useQueryClient } from '@tanstack/react-query';
import { pluginKeys } from '@/hooks/queryKeys';
import { pluginManager } from '../PluginManager';

export function useLoadPlugin() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (pluginId: string) => pluginManager.loadPlugin(pluginId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: pluginKeys.list() });
    },
  });
}

export function useUnloadPlugin() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (pluginId: string) => pluginManager.unloadPlugin(pluginId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: pluginKeys.list() });
    },
  });
}

export function useReloadPlugin() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (pluginId: string) => pluginManager.reloadPlugin(pluginId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: pluginKeys.list() });
    },
  });
}
