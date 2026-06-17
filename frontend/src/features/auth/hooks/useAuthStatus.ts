/**
 * React Query hook for auth status.
 */
import { useQuery } from '@tanstack/react-query';
import { getAuthStatus } from '../api/auth';
import { authKeys } from '@/hooks/queryKeys';

export function useAuthStatus(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: authKeys.status(),
    queryFn: () => getAuthStatus(),
    staleTime: Infinity,
    enabled: options?.enabled ?? true,
  });
}
