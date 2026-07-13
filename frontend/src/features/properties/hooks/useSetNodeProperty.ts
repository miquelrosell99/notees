/**
 * useSetNodeProperty
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as nodesApi from '@/api/nodes';
import type { BatchPropertiesResult } from '@/api/nodes';
import { nodeKeys, nodeViewKeys } from '@/hooks/queryKeys';


export function useSetNodeProperty() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ nodeUuid, propertyId, value }: { nodeUuid: string; propertyId: string; value: unknown }) => {
      if (!nodeUuid) throw new Error('Node UUID not found');
      if (!propertyId) throw new Error('Property UUID not found');
      if (value === null) {
        return nodesApi.removeProperty(nodeUuid, propertyId);
      }
      return nodesApi.setProperty(nodeUuid, propertyId, value);
    },

    onMutate: async ({ nodeUuid, propertyId, value }) => {
      const batchQueries = queryClient.getQueriesData<BatchPropertiesResult>({
        predicate: (q) =>
          Array.isArray(q.queryKey) && q.queryKey.includes('batch-properties'),
      });

      await queryClient.cancelQueries({
        predicate: (q) =>
          Array.isArray(q.queryKey) && q.queryKey.includes('batch-properties'),
      });

      const snapshots: [readonly unknown[], BatchPropertiesResult | undefined][] = [];

      for (const [queryKey, data] of batchQueries) {
        snapshots.push([queryKey, data]);

        if (!data) continue;

        if (!queryKey.includes(nodeUuid)) continue;

        const nodeEntry = data[String(nodeUuid)] ?? {};

        queryClient.setQueryData<BatchPropertiesResult>(queryKey, {
          ...data,
          [String(nodeUuid)]: value === null
            ? (() => {
                const { [String(propertyId)]: _, ...rest } = nodeEntry;
                return rest;
              })()
            : {
                ...nodeEntry,
                [String(propertyId)]: value,
              },
        });
      }

      return { snapshots };
    },

    onError: (error, { nodeUuid, propertyId }, context) => {
      console.error(`Failed to set property ${propertyId} on node ${nodeUuid}:`, error);

      if (context?.snapshots) {
        for (const [queryKey, previous] of context.snapshots) {
          queryClient.setQueryData(queryKey, previous);
        }
      }
    },

    onSettled: (_, __, { nodeUuid }) => {
      queryClient.invalidateQueries({ queryKey: nodeKeys.detailBase(nodeUuid) });
      queryClient.invalidateQueries({ queryKey: nodeKeys.pageContent(nodeUuid) });

      // List/query collections render nodes from view results; without this the
      // runtime never learns the new property values (e.g. task_status), so
      // badges and task cycling in list view go stale.
      queryClient.invalidateQueries({ queryKey: nodeViewKeys.queryResults() });

      queryClient.invalidateQueries({
        predicate: (q) =>
          Array.isArray(q.queryKey) && q.queryKey.includes('batch-properties'),
        refetchType: 'none',
      });
    },
  });
}
