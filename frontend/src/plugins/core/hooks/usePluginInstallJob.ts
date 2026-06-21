import { useQuery } from '@tanstack/react-query';
import { pluginKeys } from '@/hooks/queryKeys';
import { getInstallJob } from '../api';

export function usePluginInstallJob(jobId: string | null) {
  return useQuery({
    queryKey: pluginKeys.installJob(jobId),
    queryFn: () => getInstallJob(jobId!),
    enabled: jobId !== null,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return 1000;
      return data.status === 'pending' || data.status === 'running' ? 1000 : false;
    },
  });
}
