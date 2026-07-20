/**
 * React Query hook for chart aggregation against the local-first SQLite store.
 */
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useWorkspaceStore } from '@/core/hooks/useWorkspaceStore';
import { executeQuery } from '@/core/query/executeQuery';
import { queryOne } from '@/core/db/sqlite';
import { nodeViewKeys } from '@/hooks/queryKeys';
import { createEmptyQueryAST } from '@/types/queryAST';
import type { QueryAST } from '@/types/queryAST';
import type { QueryExecuteRequest, QueryExecuteResponse } from '@/types/nodeView';

function readViewAst(db: ReturnType<typeof useWorkspaceStore>['store'], viewId: string): QueryAST {
  if (!db) return createEmptyQueryAST();
  const row = queryOne<{ query_ast: string | null }>(
    db.getDb(),
    'SELECT query_ast FROM node_view WHERE id = ?',
    [viewId]
  );
  if (!row?.query_ast) return createEmptyQueryAST();
  try {
    return JSON.parse(row.query_ast) as QueryAST;
  } catch {
    return createEmptyQueryAST();
  }
}

export function useChartAggregate(
  viewId: string | null | undefined,
  aggregation: QueryExecuteRequest['aggregation'],
  nodeUuid?: string
) {
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const { store } = useWorkspaceStore(workspaceId ?? '');
  const hasBackendAggregation = viewId != null && viewId !== '';

  return useQuery<QueryExecuteResponse | null>({
    queryKey: nodeViewKeys.aggregate(viewId, aggregation, nodeUuid),
    queryFn: async () => {
      if (!viewId || !store) return null;
      const viewAst = readViewAst(store, viewId);
      return executeQuery(
        store,
        {
          query_ast: viewAst,
          runtime_params: { current_node_uuid: nodeUuid },
          aggregation,
        },
        nodeUuid
      );
    },
    enabled: hasBackendAggregation && !!store,
    staleTime: 30_000,
  });
}
