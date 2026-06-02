/**
 * useOfflineQueue — React hook for managing the offline mutation queue.
 *
 * Responsibilities:
 * - Track pending mutation count
 * - Auto-drain queue when connection is restored
 * - Expose drain progress and errors
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { offlineQueue } from '@/lib/offlineQueue';
import { useOnlineStatus } from './useOnlineStatus';
import { useUpdateNode, useCreateNode, useDeleteNode, useMoveNode } from './useNodeMutations';
import { getNodeGraphRuntime } from '@/runtime/NodeGraphRuntime';
import { useNotificationStore } from '@/stores/notificationStore';

interface UseOfflineQueueResult {
  /** Number of mutations waiting in the queue. */
  pendingCount: number;
  /** Whether the queue is currently draining. */
  isDraining: boolean;
  /** Manually trigger a drain (returns counts). */
  drain: () => Promise<{ succeeded: number; failed: number; dropped: number }>;
  /** The last drain result, if any. */
  lastResult: { succeeded: number; failed: number; dropped: number } | null;
}

export function useOfflineQueue(): UseOfflineQueueResult {
  const isOnline = useOnlineStatus();
  const updateNode = useUpdateNode();
  const createNode = useCreateNode();
  const deleteNode = useDeleteNode();
  const moveNode = useMoveNode();
  const [pendingCount, setPendingCount] = useState(0);
  const [isDraining, setIsDraining] = useState(false);
  const [lastResult, setLastResult] = useState<{
    succeeded: number;
    failed: number;
    dropped: number;
  } | null>(null);

  // Keep refs to avoid stale closure in the drain callback
  const updateRef = useRef(updateNode.mutateAsync);
  const createRef = useRef(createNode.mutateAsync);
  const deleteRef = useRef(deleteNode.mutateAsync);
  const moveRef = useRef(moveNode.mutateAsync);
  updateRef.current = updateNode.mutateAsync;
  createRef.current = createNode.mutateAsync;
  deleteRef.current = deleteNode.mutateAsync;
  moveRef.current = moveNode.mutateAsync;

  // Poll pending count
  const refreshCount = useCallback(async () => {
    const count = await offlineQueue.count();
    setPendingCount(count);
  }, []);

  useEffect(() => {
    refreshCount();
    const interval = setInterval(refreshCount, 2000);
    return () => clearInterval(interval);
  }, [refreshCount]);

  const drain = useCallback(async () => {
    setIsDraining(true);
    try {
      const result = await offlineQueue.drain(async (item) => {
        if (item.type === 'content') {
          await updateRef.current({ id: item.blockId, data: item.data });
          return;
        }

        const runtime = getNodeGraphRuntime();

        if (item.type === 'create_block') {
          const parentServerId = runtime.resolveParentServerId(item.parentBlockUuid);
          if (parentServerId == null) {
            throw new Error(`Parent server ID not found for ${item.parentBlockUuid}`);
          }
          await createRef.current({
            name: item.name,
            parent_id: parentServerId,
            sequence: item.sequence,
          });
          return;
        }

        if (item.type === 'delete_block') {
          const node = runtime.getNode(item.blockUuid);
          const serverId = node?.serverId;
          if (serverId == null) {
            // Block was never persisted — just skip
            return;
          }
          await deleteRef.current(serverId);
          return;
        }

        if (item.type === 'move_block') {
          const node = runtime.getNode(item.blockUuid);
          const serverId = node?.serverId;
          if (serverId == null) {
            throw new Error(`Server ID not found for ${item.blockUuid}`);
          }
          const parentServerId = item.parentBlockUuid
            ? runtime.resolveParentServerId(item.parentBlockUuid)
            : null;
          await moveRef.current({ id: serverId, parentId: parentServerId, position: item.sequence });
        }
      });
      setLastResult(result);
      await refreshCount();

      // Show notifications for failures / drops
      if (result.failed > 0) {
        useNotificationStore.getState().warning(
          'Sync delayed',
          `${result.failed} change${result.failed === 1 ? '' : 's'} could not sync and will retry.`,
        );
      }
      if (result.dropped > 0) {
        useNotificationStore.getState().error(
          'Sync conflict',
          `${result.dropped} change${result.dropped === 1 ? '' : 's'} failed permanently. You may need to redo them.`,
        );
      }
      if (result.succeeded > 0 && result.failed === 0 && result.dropped === 0) {
        useNotificationStore.getState().success(
          'Synced',
          `${result.succeeded} change${result.succeeded === 1 ? '' : 's'} synced successfully.`,
        );
      }

      return result;
    } finally {
      setIsDraining(false);
    }
  }, [refreshCount]);

  // Auto-drain when coming back online
  const hasDrainedRef = useRef(false);
  useEffect(() => {
    if (isOnline && pendingCount > 0 && !isDraining) {
      if (!hasDrainedRef.current) {
        hasDrainedRef.current = true;
        drain().catch(console.error);
      }
    } else if (!isOnline) {
      hasDrainedRef.current = false;
    }
  }, [isOnline, pendingCount, isDraining, drain]);

  return {
    pendingCount,
    isDraining,
    drain,
    lastResult,
  };
}
