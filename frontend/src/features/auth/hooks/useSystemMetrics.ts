/**
 * React Query hook for admin system metrics.
 */
import { useQuery } from '@tanstack/react-query';
import { getAdminMetrics } from '@/features/auth';
import { adminKeys } from '@/hooks/queryKeys';

export function useSystemMetrics(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: adminKeys.metrics(),
    queryFn: getAdminMetrics,
    enabled: options?.enabled ?? true,
  });
}
