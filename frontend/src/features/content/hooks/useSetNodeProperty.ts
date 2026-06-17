/**
 * useSetNodeProperty
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as nodesApi from '@/api/nodes';
import type { BatchPropertiesResult } from '@/api/nodes';
import { nodeKeys } from '@/hooks/queryKeys';

export function useSetNodeProperty() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ nodeId, propertyId, value }: { nodeId: number; propertyId: number; value: unknown }) => {
      if (value === null) {
        return nodesApi.removeProperty(nodeId, propertyId);
      }
      return nodesApi.setProperty(nodeId, propertyId, value);
    },

    onMutate: async ({ nodeId, propertyId, value }) => {
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

        if (!queryKey.includes(nodeId)) continue;

        const nodeEntry = data[String(nodeId)] ?? {};

        queryClient.setQueryData<BatchPropertiesResult>(queryKey, {
          ...data,
          [String(nodeId)]: value === null
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

    onError: (error, { nodeId, propertyId }, context) => {
      console.error(`Failed to set property ${propertyId} on node ${nodeId}:`, error);

      if (context?.snapshots) {
        for (const [queryKey, previous] of context.snapshots) {
          queryClient.setQueryData(queryKey, previous);
        }
      }
    },

    onSettled: (_, __, { nodeId }) => {
      queryClient.invalidateQueries({ queryKey: nodeKeys.detailBase(nodeId) });
      queryClient.invalidateQueries({ queryKey: nodeKeys.pageContent(nodeId) });

      queryClient.invalidateQueries({
        predicate: (q) =>
          Array.isArray(q.queryKey) && q.queryKey.includes('batch-properties'),
        refetchType: 'none',
      });
    },
  });
}
