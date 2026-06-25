/**
 * SyncManager — the sole adapter between OperationRuntime and TanStack Query.
 *
 * Mounted once at the app root, this component observes pending operations
 * from the pure runtime and dispatches them through useMutation hooks.
 * On success it updates the cache and acknowledges the operation.
 * On failure it reports the error so the runtime can retry.
 */

import { useEffect, useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { getOperationRuntime, withInFlight } from '@/runtime';
import * as nodesApi from '@/api/nodes';
import type { Node, NodeCreate, NodeUpdate } from '@/types/api';
import { executeOperation, applyCacheUpdate, buildTagNodeFromRuntime } from './mutationMap';
import type { Operation } from '@/runtime';
import type { SyncApi } from './mutationMap';

export interface SyncManagerProps {
  /** Inject API implementations for tests. Defaults to real nodesApi. */
  api?: SyncApi;
}

export function SyncManager({ api: apiProp }: SyncManagerProps = {}): null {
  const queryClient = useQueryClient();
  const runtime = getOperationRuntime();
  const dispatchedRef = useRef<Set<string>>(new Set());

  const createNode = useMutation<Node, Error, NodeCreate>({
    mutationFn: nodesApi.createNode,
  });
  const updateNode = useMutation<Node, Error, { nodeUuid: string; data: NodeUpdate }>({
    mutationFn: ({ nodeUuid, data }) => nodesApi.updateNode(nodeUuid, data),
  });
  const deleteNode = useMutation<void, Error, string>({
    mutationFn: nodesApi.deleteNode,
  });
  const addClass = useMutation<Node, Error, { nodeUuid: string; classUuid: string }>({
    mutationFn: ({ nodeUuid, classUuid }) => nodesApi.addClass(nodeUuid, classUuid),
  });
  const removeClass = useMutation<Node, Error, { nodeUuid: string; classUuid: string }>({
    mutationFn: ({ nodeUuid, classUuid }) => nodesApi.removeClass(nodeUuid, classUuid),
  });
  const addTag = useMutation<Node, Error, { nodeUuid: string; tagUuid: string }>({
    mutationFn: async ({ nodeUuid, tagUuid }) => {
      await nodesApi.addTagLink(nodeUuid, tagUuid);
      return buildTagNodeFromRuntime(nodeUuid);
    },
  });
  const removeTag = useMutation<Node, Error, { nodeUuid: string; tagUuid: string }>({
    mutationFn: async ({ nodeUuid, tagUuid }) => {
      await nodesApi.removeTagLink(nodeUuid, tagUuid);
      return buildTagNodeFromRuntime(nodeUuid);
    },
  });
  const moveNode = useMutation<Node, Error, { nodeUuid: string; parentNodeUuid: string | null; position?: number }>({
    mutationFn: ({ nodeUuid, parentNodeUuid, position }) => nodesApi.moveNode(nodeUuid, parentNodeUuid, position),
  });

  useEffect(() => {
    const api = apiProp ?? {
      createNode: (data: NodeCreate) => createNode.mutateAsync(data),
      updateNode: (nodeUuid: string, data: NodeUpdate) => updateNode.mutateAsync({ nodeUuid, data }),
      deleteNode: (nodeUuid: string) => deleteNode.mutateAsync(nodeUuid),
      addClass: (nodeUuid: string, classUuid: string) => addClass.mutateAsync({ nodeUuid, classUuid }),
      removeClass: (nodeUuid: string, classUuid: string) => removeClass.mutateAsync({ nodeUuid, classUuid }),
      addTag: (nodeUuid: string, tagUuid: string) => addTag.mutateAsync({ nodeUuid, tagUuid }),
      removeTag: (nodeUuid: string, tagUuid: string) => removeTag.mutateAsync({ nodeUuid, tagUuid }),
      moveNode: (nodeUuid: string, parentNodeUuid: string | null, position?: number) =>
        moveNode.mutateAsync({ nodeUuid, parentNodeUuid, position }),
    };

    const dispatch = async (operation: Operation) => {
      if (dispatchedRef.current.has(operation.id)) return;
      dispatchedRef.current.add(operation.id);

      runtime.applyOperation(withInFlight(operation));

      try {
        const result = await executeOperation(operation, api);
        applyCacheUpdate(queryClient, operation, result);
        runtime.acknowledgeOperation(operation.id);
      } catch (error) {
        runtime.failOperation(operation.id, error instanceof Error ? error.message : String(error));
      } finally {
        dispatchedRef.current.delete(operation.id);
      }
    };

    const unsubscribe = runtime.subscribe(() => {
      for (const operation of runtime.getDispatchableOperations()) {
        void dispatch(operation);
      }
    });

    // Initial scan in case operations were restored before mount.
    for (const operation of runtime.getDispatchableOperations()) {
      void dispatch(operation);
    }

    return unsubscribe;
  }, [runtime, queryClient, createNode, updateNode, deleteNode, addClass, removeClass, addTag, removeTag, moveNode, apiProp]);

  return null;
}
