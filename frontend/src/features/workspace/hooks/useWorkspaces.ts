/**
 * React Query hook for listing workspaces.
 */
import { useQuery, type UseQueryOptions } from '@tanstack/react-query';
import { listWorkspaces, type WorkspaceInfo } from '../api/workspaces';
import type { PaginatedResponse } from '@/types/api';
import { workspaceKeys } from '@/hooks/queryKeys';

export function useWorkspaces<TData = PaginatedResponse<WorkspaceInfo>>(
  options?: Omit<UseQueryOptions<PaginatedResponse<WorkspaceInfo>, Error, TData>, 'queryKey' | 'queryFn'>
) {
  return useQuery<PaginatedResponse<WorkspaceInfo>, Error, TData>({
    queryKey: workspaceKeys.all,
    queryFn: () => listWorkspaces(),
    staleTime: 30000,
    ...options,
  });
}
