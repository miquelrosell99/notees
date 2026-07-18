/**
 * React Query hook for fetching multiple nodes by UUID from the local-first core store.
 */
import { useQuery } from '@tanstack/react-query';
import { nodeKeys } from '@/hooks/queryKeys';
import { useCurrentWorkspaceUuid } from '@/hooks/useCurrentWorkspaceUuid';
import { useWorkspaceStore } from '@/core/hooks/useWorkspaceStore';
import { projectNode } from '@/core/adapters/nodeProjection';
import type { BatchGetNodesByUuidResponse } from '@/types/api';

export function useBatchNodesByUuid(nodeUuids: string[]) {
  const workspaceUuid = useCurrentWorkspaceUuid();
  const { store, isLoading, error } = useWorkspaceStore(workspaceUuid ?? '');

  const result = useQuery<BatchGetNodesByUuidResponse>({
    queryKey: nodeKeys.uuidBatch(nodeUuids),
    queryFn: () => {
      if (!store) throw new Error('Workspace store is not ready');
      const nodes: BatchGetNodesByUuidResponse['nodes'] = {};
      for (const uuid of nodeUuids) {
        const node = projectNode(store, uuid);
        if (node) {
          nodes[uuid] = node;
        }
      }
      return { nodes };
    },
    enabled: nodeUuids.length > 0 && !!store,
    staleTime: 5 * 60 * 1000,
  });

  return {
    ...result,
    isLoading: result.isLoading || isLoading,
    error: result.error ?? error,
  };
}
