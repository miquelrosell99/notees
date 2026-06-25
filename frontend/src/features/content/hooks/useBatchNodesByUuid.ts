/**
 * React Query hook for fetching multiple nodes by UUID in a single call.
 */
import { useQuery } from '@tanstack/react-query';
import { batchGetNodesByUuid } from '@/api/nodes';
import { nodeKeys } from '@/hooks/queryKeys';
import type { BatchGetNodesByUuidResponse } from '@/types/api';

export function useBatchNodesByUuid(nodeUuids: string[]) {
  return useQuery<BatchGetNodesByUuidResponse>({
    queryKey: nodeKeys.uuidBatch(nodeUuids),
    queryFn: async () => {
      if (nodeUuids.length === 0) return { nodes: {} };
      return batchGetNodesByUuid({ uuids: nodeUuids });
    },
    enabled: nodeUuids.length > 0,
    staleTime: 5 * 60 * 1000,
  });
}
