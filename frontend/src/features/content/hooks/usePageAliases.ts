/**
 * React Query hook for fetching page aliases.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as nodesApi from '@/api/nodes';
import { nodeKeys } from '@/hooks/queryKeys';
import type { Node } from '@/types/api';
import { getNodeUuidByServerId } from './useNodeMutations.utils';

export function usePageAliases(nodeId: number | null | undefined, options?: { enabled?: boolean }) {
  const queryClient = useQueryClient();
  return useQuery<Node[], Error>({
    queryKey: nodeKeys.aliases(nodeId ?? 0),
    queryFn: () => {
      const nodeUuid = getNodeUuidByServerId(queryClient, nodeId!);
      if (!nodeUuid) throw new Error('Node UUID not found');
      return nodesApi.getAliases(nodeUuid);
    },
    enabled: !!nodeId && (options?.enabled ?? true),
  });
}
