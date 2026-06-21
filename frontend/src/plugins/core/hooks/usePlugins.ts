import { useQuery } from '@tanstack/react-query';
import { pluginKeys } from '@/hooks/queryKeys';
import { listPlugins } from '../api';

export function usePlugins(enabled = true) {
  return useQuery({
    queryKey: pluginKeys.list(),
    queryFn: listPlugins,
    enabled,
  });
}
