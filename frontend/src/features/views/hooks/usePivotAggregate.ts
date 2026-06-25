/**
 * React Query hook for pivot table backend aggregation.
 */
import { useQuery } from '@tanstack/react-query';
import { executeNodeViewQuery } from '@/api/nodeViews';
import { nodeViewKeys } from '@/hooks/queryKeys';
import type { QueryExecuteRequest } from '@/types/nodeView';
import { resolveNodeViewUuid } from '@/utils/resolveNodeUuid';

export function usePivotAggregate(
  viewId: string | number | null | undefined,
  aggregation: QueryExecuteRequest['aggregation'],
  nodeUuid?: string
) {
  const hasBackendAggregation = viewId != null && viewId !== '';

  return useQuery({
    queryKey: nodeViewKeys.aggregate(viewId, aggregation, nodeUuid),
    queryFn: async () => {
      if (!viewId) return null;
      const viewUuid = typeof viewId === 'string' ? viewId : resolveNodeViewUuid(viewId);
      if (!viewUuid) return null;
      return executeNodeViewQuery(viewUuid, {
        runtime_params: { current_node_uuid: nodeUuid },
        aggregation,
      });
    },
    enabled: hasBackendAggregation,
    staleTime: 30_000,
  });
}
