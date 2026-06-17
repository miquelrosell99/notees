/**
 * React Query mutation for creating a new workspace.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createWorkspace } from '../api/workspaces';
import { workspaceKeys } from '@/hooks/queryKeys';

export function useCreateWorkspace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createWorkspace,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: workspaceKeys.all });
    },
  });
}
