import { useMutation, type UseMutationResult, useQueryClient } from '@tanstack/react-query';
import { nodeKeys, nodeViewKeys } from '@/hooks/queryKeys';
import { useSetProperty, useUnsetProperty } from '../hooks';

/**
 * Adapter for setting or removing a property value on a node. Writes through the
 * SQLite core store; legacy API fallback has been removed.
 */
export function useSetNodePropertyAdapter(): UseMutationResult<
  void,
  Error,
  { nodeUuid: string; propertyId: string; value: unknown }
> {
  const queryClient = useQueryClient();
  const setProperty = useSetProperty();
  const unsetProperty = useUnsetProperty();

  return useMutation<void, Error, { nodeUuid: string; propertyId: string; value: unknown }>({
    mutationFn: async ({ nodeUuid, propertyId, value }) => {
      if (value === null) {
        await unsetProperty.mutateAsync({ nodeId: nodeUuid, schemaId: propertyId });
      } else {
        await setProperty.mutateAsync({ nodeId: nodeUuid, schemaId: propertyId, value });
      }
    },
    onSuccess: (_, { nodeUuid }) => {
      queryClient.invalidateQueries({ queryKey: nodeKeys.detailBase(nodeUuid) });
      queryClient.invalidateQueries({ queryKey: nodeKeys.pageContent(nodeUuid) });
      queryClient.invalidateQueries({ queryKey: nodeViewKeys.queryResults() });
    },
  });
}
