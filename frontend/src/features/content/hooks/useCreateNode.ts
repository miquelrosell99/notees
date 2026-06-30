/**
 * useCreateNode
 *
 * TanStack Query mutation hook for creating nodes.
 *
 * For blocks (parent_uuid present): integrates with the runtime intent system.
 * The runtime records a `create_block` intent which provides optimistic
 * rendering. The API is still fired directly (preserving mutateAsync for
 * programmatic callers). On success the intent is consumed.
 *
 * For pages/tags/classes (no parent_uuid): fires the API directly and patches
 * caches through the unified cache helpers.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as nodesApi from '@/api/nodes';
import type { NodeCreate, Node } from '@/types/api';
import { nodeKeys } from '@/hooks/queryKeys';
import { nodeViewKeys } from './useNodeViews';
import { getOperationRuntime } from '@/runtime';
import { getNode } from '@/runtime/graphHelpers';
import { removeNodes } from '@/runtime/eventBus';
import { remapBlockId } from '@/runtime/serverIdMap';
import { getUndoEngine } from '@/stores/undoEngine';
import { getRuntimeEventBus } from '@/runtime/eventBus';
import { invalidateNodeCaches } from './useNodeMutations.utils';
import { insertChildIntoTreeCaches } from '@/hooks/cacheUtils';
import { inFlightBlocks } from './useBlockPersist.utils';
import { generateUUID } from '@/utils/uuid';

export function useCreateNode() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: NodeCreate) => nodesApi.createNode(data),
    onMutate: async (variables) => {
      if (!variables.parent_uuid) {
        return { optimisticNode: null, runtimeBlockId: null, mutationKey: null };
      }

      const parentUuid = variables.parent_uuid;
      const runtime = getOperationRuntime();

      // Verify the parent exists in the runtime for optimistic rendering
      const parentGraphNode = getNode(runtime, parentUuid);
      if (!parentGraphNode) {
        // Parent not in runtime — fall back to direct API without optimistic state
        return { optimisticNode: null, runtimeBlockId: null, mutationKey: null };
      }

      // Cancel outgoing refetches
      await queryClient.cancelQueries({ queryKey: nodeKeys.detailBase(parentUuid) });
      await queryClient.cancelQueries({ queryKey: nodeKeys.pageContent(parentUuid) });
      await queryClient.cancelQueries({ queryKey: nodeKeys.pageContents() });

      // Create a runtime intent for optimistic rendering
      const blockId = generateUUID();
      const contentAST = variables.name
        ? [{ type: 'paragraph' as const, children: [{ type: 'text' as const, text: variables.name }] }]
        : [{ type: 'paragraph' as const, children: [{ type: 'text' as const, text: '' }] }];

      // If the caller supplied a target sequence, find the sibling that will
      // sit immediately before the new block so the optimistic position matches
      // the eventual server order.
      const siblings = runtime.getChildren(parentUuid);
      let afterBlockId: string | null = null;
      if (variables.sequence !== undefined && variables.sequence !== null) {
        const targetSequence = variables.sequence;
        const firstAfter = siblings.find((s) => s.orderIndex >= targetSequence);
        if (firstAfter) {
          const index = siblings.indexOf(firstAfter);
          afterBlockId = index > 0 ? siblings[index - 1].blockId : null;
        } else {
          afterBlockId = siblings.length > 0 ? siblings[siblings.length - 1].blockId : null;
        }
      }

      await getUndoEngine().applyIntent({
        type: 'create_block',
        parentId: parentUuid,
        afterBlockId,
        blockId,
        contentAST,
      });
      getRuntimeEventBus().flushEvents();

      // Capture the create operation id so we can acknowledge it after the
      // direct API call succeeds. This prevents SyncManager from dispatching
      // the same create a second time.
      const operationId = getOperationRuntime()
        .getOperationsForBlock(blockId)
        .find((op) => op.type === 'create')?.id;
      inFlightBlocks.add(blockId);

      return { optimisticNode: null, runtimeBlockId: blockId, operationId };
    },
    onSuccess: (newNode, variables, context) => {
      const { runtimeBlockId, operationId } = context || {};

      if (runtimeBlockId) {
        inFlightBlocks.delete(runtimeBlockId);
      }

      // Add the new node to its own detail cache
      queryClient.setQueriesData<Node>(
        { queryKey: nodeKeys.detailBase(newNode.uuid) },
        () => newNode
      );

      if (variables.parent_uuid && runtimeBlockId) {
        remapBlockId(runtimeBlockId, newNode.uuid);
        // Acknowledge the runtime create operation so SyncManager does not
        // dispatch a duplicate create request.
        if (operationId) {
          getOperationRuntime().acknowledgeOperation(operationId);
        }
      } else if (variables.parent_uuid && newNode.parent_uuid) {
        // No runtime optimistic state — insert into caches directly.
        insertChildIntoTreeCaches(queryClient, newNode.parent_uuid, newNode);
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

      if (newNode.is_page && newNode.parent_uuid) {
        invalidateNodeCaches(queryClient, {
          nodeUuid: newNode.parent_uuid,
          refetch: true,
        });
      }
    },
    onError: (_error, variables, context) => {
      const { runtimeBlockId } = context || {};

      if (runtimeBlockId) {
        inFlightBlocks.delete(runtimeBlockId);
      }

      if (variables.parent_uuid && runtimeBlockId) {
        // Roll back the optimistic block from the runtime
        removeNodes([runtimeBlockId]);
      }
    },
  });
}
