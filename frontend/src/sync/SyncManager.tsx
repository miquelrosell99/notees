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
  const updateNode = useMutation<Node, Error, { id: number; data: NodeUpdate }>({
    mutationFn: ({ id, data }) => nodesApi.updateNode(id, data),
  });
  const deleteNode = useMutation<void, Error, number>({
    mutationFn: nodesApi.deleteNode,
  });
  const addClass = useMutation<Node, Error, { id: number; classId: number }>({
    mutationFn: ({ id, classId }) => nodesApi.addClass(id, classId),
  });
  const removeClass = useMutation<Node, Error, { id: number; classId: number }>({
    mutationFn: ({ id, classId }) => nodesApi.removeClass(id, classId),
  });
  const addTag = useMutation<Node, Error, { id: number; tagId: number }>({
    mutationFn: async ({ id, tagId }) => {
      await nodesApi.addTagLink(id, tagId);
      return buildTagNodeFromRuntime(id);
    },
  });
  const removeTag = useMutation<Node, Error, { id: number; tagId: number }>({
    mutationFn: async ({ id, tagId }) => {
      await nodesApi.removeTagLink(id, tagId);
      return buildTagNodeFromRuntime(id);
    },
  });
  const moveNode = useMutation<Node, Error, { id: number; parentId: number; position?: number }>({
    mutationFn: ({ id, parentId, position }) => nodesApi.moveNode(id, parentId, position),
  });

  useEffect(() => {
    const api = apiProp ?? {
      createNode: (data: NodeCreate) => createNode.mutateAsync(data),
      updateNode: (id: number, data: NodeUpdate) => updateNode.mutateAsync({ id, data }),
      deleteNode: (id: number) => deleteNode.mutateAsync(id),
      addClass: (id: number, classId: number) => addClass.mutateAsync({ id, classId }),
      removeClass: (id: number, classId: number) => removeClass.mutateAsync({ id, classId }),
      addTag: (id: number, tagId: number) => addTag.mutateAsync({ id, tagId }),
      removeTag: (id: number, tagId: number) => removeTag.mutateAsync({ id, tagId }),
      moveNode: (id: number, parentId: number | null, position?: number) =>
        moveNode.mutateAsync({ id, parentId: parentId ?? 0, position }),
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
