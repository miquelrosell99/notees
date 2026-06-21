import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { pluginSettingsKeys } from '@/hooks/queryKeys';
import { getPluginSettings, setPluginSetting } from '../api';

export function usePluginSettings(pluginId: string) {
  return useQuery({
    queryKey: pluginSettingsKeys.forPlugin(pluginId),
    queryFn: () => getPluginSettings(pluginId),
    enabled: !!pluginId,
  });
}

export function useSetPluginSetting(pluginId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ key, value }: { key: string; value: unknown }) =>
      setPluginSetting(pluginId, key, value),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: pluginSettingsKeys.forPlugin(pluginId) });
    },
  });
}
