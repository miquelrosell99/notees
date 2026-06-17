/**
 * React Query hook for batch-fetching nodes by ID.
 */
import { useQuery } from '@tanstack/react-query';
import { batchGetNodes } from '@/api/nodes';
import { nodeKeys } from '@/hooks/queryKeys';
import type { BatchGetNodesResponse } from '@/types/api';

export function useBatchNodes(nodeIds: number[]) {
  return useQuery<BatchGetNodesResponse>({
    queryKey: nodeKeys.tabBatch(nodeIds),
    queryFn: async () => {
      if (nodeIds.length === 0) return { nodes: {} };
      return batchGetNodes({ ids: nodeIds });
    },
    enabled: nodeIds.length > 0,
    staleTime: 1000 * 60 * 5,
  });
}
