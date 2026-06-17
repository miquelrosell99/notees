/**
 * React Query mutation for emptying the trash.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { emptyTrash } from '@/api/nodes';
import { trashKeys, nodeKeys } from '@/hooks/queryKeys';

export function useEmptyTrash() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: emptyTrash,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: trashKeys.all });
      queryClient.invalidateQueries({ queryKey: nodeKeys.lists() });
      queryClient.invalidateQueries({ queryKey: nodeKeys.allLinkedRefs(), refetchType: 'active' });
      queryClient.invalidateQueries({ queryKey: nodeKeys.allPropertyBacklinks(), refetchType: 'active' });
      queryClient.invalidateQueries({ queryKey: nodeKeys.allBacklinks(), refetchType: 'active' });
    },
  });
}
