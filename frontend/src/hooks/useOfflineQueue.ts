/**
 * useOfflineQueue — React hook for managing the offline mutation queue.
 *
 * Responsibilities:
 * - Track pending intent count from the runtime
 * - Auto-drain pending intents when connection is restored
 * - Expose drain progress and errors
 *
 * The runtime's pendingIntents map is the single source of truth for
 * offline operations. This hook scans it and fires the appropriate API
 * calls directly (bypassing the mutation hooks to avoid duplicate
 * runtime intent registration).
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useOnlineStatus } from './useOnlineStatus';
import { getNodeGraphRuntime } from '@/runtime/NodeGraphRuntime';
import { useNotificationStore } from '@/stores/notificationStore';
import * as nodesApi from '@/api/nodes';
import { serializeContentForAPI } from './useBlockPersist.utils';
import type { PendingIntent } from '@/runtime/types';

interface UseOfflineQueueResult {
  pendingCount: number;
  isDraining: boolean;
  drain: () => Promise<{ succeeded: number; failed: number; dropped: number }>;
  lastResult: { succeeded: number; failed: number; dropped: number } | null;
}

export function useOfflineQueue(): UseOfflineQueueResult {
  const isOnline = useOnlineStatus();
  const [pendingCount, setPendingCount] = useState(0);
  const [isDraining, setIsDraining] = useState(false);
  const [lastResult, setLastResult] = useState<{
    succeeded: number;
    failed: number;
    dropped: number;
  } | null>(null);

  const refreshCount = useCallback(() => {
    const runtime = getNodeGraphRuntime();
    const count = runtime.getAllPendingIntents().length;
    setPendingCount(count);
  }, []);

  useEffect(() => {
    refreshCount();
    const interval = setInterval(refreshCount, 2000);
    return () => clearInterval(interval);
  }, [refreshCount]);

  const drain = useCallback(async () => {
    setIsDraining(true);
    const runtime = getNodeGraphRuntime();

    let succeeded = 0;
    let failed = 0;
    let dropped = 0;

    try {
      // Keep draining until no pending intents remain
      while (true) {
        const allPending = runtime.getAllPendingIntents();
        if (allPending.length === 0) break;

        // Process one intent at a time to avoid races
        const pending = allPending[0];
        if (runtime.isMutationInFlight(pending.mutationKey)) {
          // Someone else is handling this intent — skip for now
          break;
        }

        runtime.markMutationInFlight(pending.mutationKey);

        try {
          await drainIntent(pending);
          runtime.consumePendingIntents(pending.mutationKey);
          succeeded++;
        } catch (error) {
          runtime.unmarkMutationInFlight(pending.mutationKey);
          const axiosError = error as { response?: { status?: number } };
          const status = axiosError.response?.status;
          if (status && status >= 400 && status < 500) {
            runtime.consumePendingIntents(pending.mutationKey);
            dropped++;
          } else {
            failed++;
          }
        }
      }

      setLastResult({ succeeded, failed, dropped });
      refreshCount();

      if (failed > 0) {
        useNotificationStore.getState().warning(
          'Sync delayed',
          `${failed} change${failed === 1 ? '' : 's'} could not sync and will retry.`,
        );
      }
      if (dropped > 0) {
        useNotificationStore.getState().error(
          'Sync conflict',
          `${dropped} change${dropped === 1 ? '' : 's'} failed permanently. You may need to redo them.`,
        );
      }
      if (succeeded > 0 && failed === 0 && dropped === 0) {
        useNotificationStore.getState().success(
          'Synced',
          `${succeeded} change${succeeded === 1 ? '' : 's'} synced successfully.`,
        );
      }

      return { succeeded, failed, dropped };
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

/**
 * Drain a single pending intent by firing the appropriate API call.
 */
async function drainIntent(pending: PendingIntent): Promise<void> {
  const runtime = getNodeGraphRuntime();
  const { intent } = pending;

  switch (intent.type) {
    case 'update_content': {
      const graphNode = runtime.getNode(intent.blockId);
      if (!graphNode?.serverId) {
        throw new Error(`Server ID not found for ${intent.blockId}`);
      }
      const name = JSON.stringify(intent.contentAST);
      await nodesApi.updateNode(graphNode.serverId, { name });
      break;
    }

    case 'create_block': {
      const graphNode = runtime.getNode(intent.blockId);
      if (!graphNode) {
        throw new Error(`Node not found for ${intent.blockId}`);
      }
      if (graphNode.serverId != null) {
        // Already persisted — skip
        return;
      }
      const parentServerId = intent.parentId
        ? runtime.resolveParentServerId(intent.parentId)
        : null;
      if (intent.parentId && parentServerId == null) {
        throw new Error(`Parent server ID not found for ${intent.parentId}`);
      }
      const name = serializeContentForAPI(graphNode.contentAST);
      const created = await nodesApi.createNode({
        name,
        parent_id: parentServerId,
        sequence: graphNode.orderIndex,
      });
      runtime.setServerId(intent.blockId, created.id);
      runtime.remapBlockId(intent.blockId, created.uuid);
      break;
    }

    case 'delete_block': {
      const graphNode = runtime.getNode(intent.blockId);
      if (!graphNode?.serverId) {
        // Never persisted — skip
        return;
      }
      await nodesApi.deleteNode(graphNode.serverId);
      break;
    }

    case 'move_block':
    case 'indent_block':
    case 'outdent_block':
    case 'move_up':
    case 'move_down': {
      const graphNode = runtime.getNode(intent.blockId);
      if (!graphNode?.serverId) {
        throw new Error(`Server ID not found for ${intent.blockId}`);
      }
      const parentServerId = graphNode.parentId
        ? runtime.resolveParentServerId(graphNode.parentId)
        : null;
      await nodesApi.updateNode(graphNode.serverId, {
        parent_id: parentServerId,
        sequence: graphNode.orderIndex,
      });
      break;
    }

    case 'reorder_blocks': {
      const parentGraphNode = runtime.getNode(intent.parentId);
      if (!parentGraphNode?.serverId) {
        throw new Error(`Server ID not found for parent ${intent.parentId}`);
      }
      for (let i = 0; i < intent.orderedBlockIds.length; i++) {
        const childNode = runtime.getNode(intent.orderedBlockIds[i]);
        if (childNode?.serverId) {
          await nodesApi.updateNode(childNode.serverId, {
            parent_id: parentGraphNode.serverId,
            sequence: i,
          });
        }
      }
      break;
    }

    default:
      // Unhandled intent type — consume it to avoid infinite loops
      console.warn('[useOfflineQueue] Unhandled intent type:', intent.type);
      return;
  }
}
