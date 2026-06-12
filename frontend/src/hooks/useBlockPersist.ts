/**
 * useBlockPersist — Persists runtime pending intents to the backend API.
 *
 * Uses the runtime's pending-intent system to discover unpersisted blocks,
 * fires TanStack Query mutations, and consumes intents on success.
 */

import { useEffect, useRef, useCallback } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { getNodeGraphRuntime } from '@/runtime/NodeGraphRuntime';
import { createNode as createNodeApi } from '@/api/nodes';
import type { NodeCreate } from '@/types/api';
import { nodeKeys } from './queryKeys';
// offline queue removed — pending intents are the single offline queue
import type { PendingIntent } from '@/runtime/types';
import {
  inFlightBlocks,
  pendingContentSaves,
  pendingDeleteUuids,
  queueContentSave,
  isBlockPending,
  scheduleDeleteFlush,
  serializeContentForAPI,
  flushQueuedContent,
  isRetryableError,
  setActiveInstanceId,
  getActiveInstanceId,
} from './useBlockPersist.utils';
import {
  removeNodeFromAllCaches,
  removeNodeFromLinkedRefCaches,
  removeNodeFromPropertyBacklinkCaches,
} from './cacheUtils';

// Re-export utility functions for consumers
export { queueContentSave, isBlockPending };

// ─── Hook ─────────────────────────────────────────────────────────

interface UseBlockPersistOptions {
  /** When false, the hook becomes a no-op. */
  enabled?: boolean;
  /** Called after a block is successfully persisted */
  onPersisted?: (blockId: string, serverId: number) => void;
  /** Called on persist error */
  onError?: (blockId: string, error: Error) => void;
}

export function useBlockPersist(options: UseBlockPersistOptions = {}) {
  const { enabled = true, onPersisted, onError } = options;
  const instanceIdRef = useRef(Math.random().toString(36));
  const queryClient = useQueryClient();

  // Direct API mutation — no query invalidation to avoid refetch loops
  const createNodeMutation = useMutation({
    mutationFn: (data: NodeCreate) => createNodeApi(data),
  });

  // Persist a single pending create_block intent
  const persistIntent = useCallback((pending: PendingIntent) => {
    const runtime = getNodeGraphRuntime();
    const { intent, mutationKey } = pending;

    if (intent.type !== 'create_block') return;

    const blockId = intent.blockId;
    if (inFlightBlocks.has(blockId)) return;
    if (runtime.isMutationInFlight(mutationKey)) return;

    const graphNode = runtime.getNode(blockId);
    if (!graphNode) return;
    if (graphNode.serverId != null) return; // Already persisted

    let parentServerId: number | null = null;
    if (graphNode.parentId) {
      parentServerId = runtime.resolveParentServerId(graphNode.parentId);
      if (parentServerId == null) {
        return;
      }
    }

    inFlightBlocks.add(blockId);

    const name = serializeContentForAPI(graphNode.contentAST);

    createNodeMutation.mutate(
      {
        name,
        parent_id: parentServerId,
        sequence: graphNode.orderIndex,
      },
      {
        onSuccess: (createdNode) => {
          inFlightBlocks.delete(blockId);

          runtime.setServerId(blockId, createdNode.id);
          runtime.remapBlockId(blockId, createdNode.uuid);
          runtime.consumePendingIntents(mutationKey);

          const newBlockId = createdNode.uuid;
          onPersisted?.(newBlockId, createdNode.id);

          // Flush any queued content save for this block BEFORE invalidating
          const queuedContent = pendingContentSaves.get(blockId);
          if (queuedContent != null) {
            pendingContentSaves.delete(blockId);
            flushQueuedContent(createdNode.id, queuedContent).then(() => {
              if (parentServerId != null) {
                queryClient.invalidateQueries({
                  queryKey: nodeKeys.detailBase(parentServerId),
                });
              }
              queryClient.invalidateQueries({
                queryKey: nodeKeys.detailBase(createdNode.id),
              });
            });
          } else {
            if (parentServerId != null) {
              queryClient.invalidateQueries({
                queryKey: nodeKeys.detailBase(parentServerId),
              });
            }
          }

          // Now check if any children were waiting on this parent
          const children = runtime.getChildren(newBlockId);
          for (const child of children) {
            if (child.serverId == null) {
              const childPending = runtime.getPendingIntentsForBlock(child.blockId);
              for (const cp of childPending) {
                if (cp.intent.type === 'create_block') {
                  persistIntent(cp);
                }
              }
            }
          }
        },
        onError: (error) => {
          inFlightBlocks.delete(blockId);
          runtime.unmarkMutationInFlight(mutationKey);
          if (!isRetryableError(error)) {
            console.error('[useBlockPersist] Failed to persist block:', blockId, error);
            onError?.(blockId, error as Error);
          }
        },
      },
    );
  }, [createNodeMutation, onPersisted, onError, queryClient]);

  // Scan for all pending create_block intents and persist them
  const persistAll = useCallback(() => {
    const runtime = getNodeGraphRuntime();
    const allPending = runtime.getAllPendingIntents();

    for (const pending of allPending) {
      if (pending.intent.type === 'create_block') {
        persistIntent(pending);
      }
    }
  }, [persistIntent]);

  // Subscribe to runtime events
  useEffect(() => {
    if (!enabled) return;

    const instanceId = instanceIdRef.current;

    if (getActiveInstanceId() === null) {
      setActiveInstanceId(instanceId);
    }

    if (getActiveInstanceId() !== instanceId) return;

    const runtime = getNodeGraphRuntime();

    const unsubscribe = runtime.subscribe((event) => {
      if (event.type === 'structure_changed' || event.type === 'nodes_changed') {
        persistAll();
      }
      if (event.type === 'block_deleted' && event.serverId != null) {
        const deletedServerId = event.serverId;

        // Remove from all caches using unified helpers
        removeNodeFromAllCaches(queryClient, deletedServerId);
        removeNodeFromLinkedRefCaches(queryClient, deletedServerId);
        removeNodeFromPropertyBacklinkCaches(queryClient, deletedServerId);

        // Block was deleted/merged in the editor — batch-persist to API
        pendingDeleteUuids.push(event.blockId);
        scheduleDeleteFlush();
        pendingContentSaves.delete(event.blockId);
        inFlightBlocks.delete(event.blockId);
      }
    });

    // Initial scan for any pending intents already in the runtime
    persistAll();

    return () => {
      unsubscribe();
      if (getActiveInstanceId() === instanceId) {
        setActiveInstanceId(null);
      }
    };
  }, [enabled, persistAll, queryClient]);
}
