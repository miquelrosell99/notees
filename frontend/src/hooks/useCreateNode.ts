/**
 * useCreateNode
 *
 * TanStack Query mutation hook for creating nodes.
 *
 * For blocks (parent_id present): integrates with the runtime intent system.
 * The runtime records a `create_block` intent which provides optimistic
 * rendering. The API is still fired directly (preserving mutateAsync for
 * programmatic callers). On success the intent is consumed.
 *
 * For pages/tags/classes (no parent_id): fires the API directly and patches
 * caches through the unified cache helpers.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as nodesApi from '@/api/nodes';
import type { NodeCreate, Node } from '@/types/api';
import { nodeKeys } from './queryKeys';
import { nodeViewKeys } from './useNodeViews';
import { getNodeGraphRuntime } from '@/runtime/NodeGraphRuntime';
import { invalidateNodeCaches } from './useNodeMutations.utils';
import { insertChildIntoTreeCaches } from './cacheUtils';

export function useCreateNode() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: NodeCreate) => nodesApi.createNode(data),
    onMutate: async (variables) => {
      if (!variables.parent_id) {
        return { optimisticNode: null, runtimeBlockId: null, mutationKey: null };
      }

      const parentId = variables.parent_id;
      const runtime = getNodeGraphRuntime();

      // Look up parent's UUID in the runtime
      const parentGraphNode = runtime.getNodeByServerId(parentId);
      const parentUuid = parentGraphNode?.blockId;
      if (!parentUuid) {
        // Parent not in runtime — fall back to direct API without optimistic state
        return { optimisticNode: null, runtimeBlockId: null, mutationKey: null };
      }

      // Cancel outgoing refetches
      await queryClient.cancelQueries({ queryKey: nodeKeys.detailBase(parentId) });
      await queryClient.cancelQueries({ queryKey: nodeKeys.pageContent(parentId) });
      await queryClient.cancelQueries({ queryKey: nodeKeys.pageContents() });

      // Create a runtime intent for optimistic rendering
      const blockId = crypto.randomUUID();
      const contentAST = variables.name
        ? [{ type: 'paragraph' as const, children: [{ type: 'text' as const, text: variables.name }] }]
        : [{ type: 'paragraph' as const, children: [{ type: 'text' as const, text: '' }] }];
      const undoEntry = runtime.applyIntent({
        type: 'create_block',
        parentId: parentUuid,
        afterBlockId: null,
        blockId,
        contentAST,
      });
      runtime.flushEvents();

      // Find the mutationKey that applyIntent generated
      const pending = runtime.getPendingIntentsForBlock(blockId);
      const mutationKey = pending.find(p => p.intent.type === 'create_block')?.mutationKey ?? null;

      return { optimisticNode: null, runtimeBlockId: blockId, mutationKey, undoEntry };
    },
    onSuccess: (newNode, variables, context) => {
      const { runtimeBlockId, mutationKey } = context || {};

      // Add the new node to its own detail cache
      queryClient.setQueriesData<Node>(
        { queryKey: nodeKeys.detailBase(newNode.id) },
        () => newNode
      );

      if (variables.parent_id && runtimeBlockId && mutationKey) {
        const runtime = getNodeGraphRuntime();
        runtime.setServerId(runtimeBlockId, newNode.id);
        runtime.remapBlockId(runtimeBlockId, newNode.uuid);
        runtime.consumePendingIntents(mutationKey);
      } else if (variables.parent_id) {
        // No runtime optimistic state — insert into caches directly
        insertChildIntoTreeCaches(queryClient, variables.parent_id, newNode);
      }

      // Invalidate common caches
      invalidateNodeCaches(queryClient, {
        lists: true,
        pages: newNode.is_page,
        classes: newNode.is_class,
        search: newNode.is_page,
        graph: newNode.is_page,
      });

      if (newNode.is_page) {
        queryClient.invalidateQueries({
          queryKey: nodeKeys.graphNodes(),
          refetchType: 'active',
        });
        queryClient.invalidateQueries({
          queryKey: nodeViewKeys.queryResults(),
          refetchType: 'active',
        });
        queryClient.invalidateQueries({
          queryKey: nodeKeys.pseudoNodeQuery(),
          refetchType: 'active',
        });
      }

      if (newNode.is_page && newNode.parent_id) {
        invalidateNodeCaches(queryClient, {
          nodeId: newNode.parent_id,
          refetch: true,
        });
      }
    },
    onError: (_error, variables, context) => {
      const { runtimeBlockId, mutationKey } = context || {};

      if (variables.parent_id && runtimeBlockId) {
        const runtime = getNodeGraphRuntime();
        if (mutationKey) {
          runtime.unmarkMutationInFlight(mutationKey);
        }
        // Roll back the optimistic block from the runtime
        runtime.removeNodes([runtimeBlockId]);
      }
    },
  });
}
