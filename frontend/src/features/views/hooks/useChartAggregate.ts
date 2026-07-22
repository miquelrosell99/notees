/**
 * React Query hook for chart aggregation against the local-first SQLite store.
 */
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useWorkspaceStoreClient } from '@/core/hooks/useWorkspaceStoreClient';
import { nodeViewKeys } from '@/hooks/queryKeys';
import type { QueryExecuteRequest, QueryExecuteResponse } from '@/types/nodeView';
import type { QueryAST } from '@/types/queryAST';

export function useChartAggregate(
  viewId: string | null | undefined,
  aggregation: QueryExecuteRequest['aggregation'],
  nodeUuid?: string
) {
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const { client } = useWorkspaceStoreClient(workspaceId ?? '');
  const hasBackendAggregation = viewId != null && viewId !== '';

  return useQuery<QueryExecuteResponse | null>({
    queryKey: nodeViewKeys.aggregate(viewId, aggregation, nodeUuid),
    queryFn: async () => {
      if (!viewId || !client) return null;
      const viewAst = await client.query<QueryAST>('readViewAst', [viewId]);
      return client.query<QueryExecuteResponse>('executeQuery', [
        {
          query_ast: viewAst,
          runtime_params: { current_node_uuid: nodeUuid },
          aggregation,
        },
        nodeUuid,
      ]);
    },
    enabled: hasBackendAggregation && !!client,
    staleTime: 30_000,
  });
}
