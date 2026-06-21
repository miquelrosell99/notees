import { useMutation, useQueryClient } from '@tanstack/react-query';
import { pluginKeys } from '@/hooks/queryKeys';
import { installPlugin } from '../api';

export function useInstallPlugin() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: installPlugin,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: pluginKeys.list() });
    },
  });
}
