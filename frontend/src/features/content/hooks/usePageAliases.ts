/**
 * React Query hook for fetching page aliases.
 */
import { useQuery } from '@tanstack/react-query';
import * as nodesApi from '@/api/nodes';
import { nodeKeys } from '@/hooks/queryKeys';
import type { Node } from '@/types/api';

export function usePageAliases(nodeId: number | null | undefined, options?: { enabled?: boolean }) {
  return useQuery<Node[], Error>({
    queryKey: nodeKeys.aliases(nodeId ?? 0),
    queryFn: () => nodesApi.getAliases(nodeId!),
    enabled: !!nodeId && (options?.enabled ?? true),
  });
}
