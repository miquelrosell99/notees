/**
 * React Query hook for chart backend aggregation.
 */
import { useQuery } from '@tanstack/react-query';
import { executeNodeViewQuery } from '@/api/nodeViews';
import { nodeViewKeys } from '@/hooks/queryKeys';
import type { QueryExecuteRequest } from '@/types/nodeView';

export function useChartAggregate(
  viewId: number | null | undefined,
  aggregation: QueryExecuteRequest['aggregation'],
  nodeUuid?: string
) {
  const hasBackendAggregation = viewId != null && viewId > 0;

  return useQuery({
    queryKey: nodeViewKeys.aggregate(viewId, aggregation, nodeUuid),
    queryFn: async () => {
      if (!viewId) return null;
      return executeNodeViewQuery(viewId, {
        runtime_params: { current_node_uuid: nodeUuid },
        aggregation,
      });
    },
    enabled: hasBackendAggregation,
    staleTime: 30_000,
  });
}
