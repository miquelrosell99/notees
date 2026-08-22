/**
 * React Query hook for listing workspaces.
 */
import { useQuery, type UseQueryOptions } from '@tanstack/react-query';
import { listWorkspaces, type WorkspaceInfo } from '../api/workspaces';
import type { PaginatedResponse } from '@/types/api';
import { workspaceKeys } from '@/hooks/queryKeys';
import { useAuthStore } from '@/stores';

export function useWorkspaces<TData = PaginatedResponse<WorkspaceInfo>>(
  options?: Omit<UseQueryOptions<PaginatedResponse<WorkspaceInfo>, Error, TData>, 'queryKey' | 'queryFn'>
) {
  const authVerified = useAuthStore((s) => s.authVerified);
  // Local sessions own a single well-known workspace; the server list endpoint
  // is never queried for them (local-first split).
  const isLocalSession = useAuthStore((s) => s.user?.isLocal === true);
  return useQuery<PaginatedResponse<WorkspaceInfo>, Error, TData>({
    queryKey: workspaceKeys.all,
    queryFn: () => listWorkspaces(),
    staleTime: 30000,
    ...options,
    enabled: (options?.enabled ?? authVerified) && !isLocalSession,
  });
}
