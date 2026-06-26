/**
 * React Query hook for fetching page aliases.
 */
import { useQuery } from '@tanstack/react-query';
import * as nodesApi from '@/api/nodes';
import { nodeKeys } from '@/hooks/queryKeys';
import type { Node } from '@/types/api';

export function usePageAliases(nodeUuid: string | null | undefined, options?: { enabled?: boolean }) {
  return useQuery<Node[], Error>({
    queryKey: nodeKeys.aliases(nodeUuid ?? ''),
    queryFn: () => {
      if (!nodeUuid) throw new Error('Node UUID not found');
      return nodesApi.getAliases(nodeUuid);
    },
    enabled: !!nodeUuid && (options?.enabled ?? true),
  });
}
