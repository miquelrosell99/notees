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
    // Auth status must be treated as volatile: after login/logout the cached
    // value can flip from false to true, and staleTime: Infinity would keep the
    // pre-login result alive forever.
    staleTime: 0,
    enabled: options?.enabled ?? true,
  });
}
