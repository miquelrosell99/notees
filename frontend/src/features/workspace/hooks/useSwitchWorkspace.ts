/**
 * React Query mutation for switching the active workspace.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { switchWorkspace } from '../api/workspaces';
import { workspaceKeys } from '@/hooks/queryKeys';

export function useSwitchWorkspace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: switchWorkspace,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: workspaceKeys.all });
    },
  });
}
