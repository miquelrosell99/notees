/**
 * React Query hook for checking workspace name availability.
 */
import { useQuery } from '@tanstack/react-query';
import { checkWorkspaceName } from '../api/workspaces';
import { workspaceKeys } from '@/hooks/queryKeys';

export function useWorkspaceNameCheck(name: string) {
  return useQuery({
    queryKey: workspaceKeys.nameCheck(name),
    queryFn: () => checkWorkspaceName(name),
    enabled: name.length >= 2,
    staleTime: 5000,
  });
}
