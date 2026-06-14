/**
 * useStructureSync - Syncs runtime structural changes to the backend database
 *
 * Uses the runtime's pending-intent system to discover what needs syncing,
 * fires TanStack Query mutations with optimistic cache updates, and consumes
 * intents on success. This makes TanStack Query the single persistent source
 * of truth and the runtime a pure ephemeral overlay.
 */

import { useEffect, useRef, useCallback } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { getNodeGraphRuntime } from '@/runtime/NodeGraphRuntime';
import { updateNode as updateNodeApi } from '@/api/nodes';
import { nodeKeys } from './queryKeys';
import type { NodeUpdate } from '@/types/api';
import type { PendingIntent } from '@/runtime/types';
import { updateNodeInTreeCaches } from './cacheUtils';

function isRetryableError(error: unknown): boolean {
  const axiosError = error as { response?: { status?: number }; message?: string };
  const status = axiosError.response?.status;
  return status == null || status >= 500;
}

interface UseStructureSyncOptions {
  /** When false, the hook becomes a no-op. */
  enabled?: boolean;
  /** Debounce delay in ms (default: 200) */
  delay?: number;
  /** Called after successful sync */
  onSynced?: (blockIds: string[]) => void;
  /** Called on sync error */
  onError?: (blockId: string, error: Error) => void;
}

// ─── Singleton coordinator ────────────────────────────────────────

class StructureSyncCoordinator {
  activeInstanceId: string | null = null;
  inFlightMutationKeys = new Set<string>();
  debounceTimeout: ReturnType<typeof setTimeout> | null = null;

  reset(): void {
    if (this.debounceTimeout) {
      clearTimeout(this.debounceTimeout);
      this.debounceTimeout = null;
    }
    this.activeInstanceId = null;
    this.inFlightMutationKeys.clear();
  }
}

const coordinator = new StructureSyncCoordinator();

// Re-export for any consumers that need to inspect state
export { coordinator };

/**
 * Hook to sync runtime structural changes (parent_id, sequence) to database.
 */
export function useStructureSync(options: UseStructureSyncOptions = {}) {
  const { enabled = true, delay = 200, onSynced, onError } = options;
  const instanceIdRef = useRef<string>(Math.random().toString(36));
  const queryClient = useQueryClient();

  const updateNodeMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: NodeUpdate }) =>
      updateNodeApi(id, data),
  });

  // Snapshot previous cache state for rollback
  const snapshotPrevious = useCallback((_serverId: number) => {
    const queryCache = queryClient.getQueryCache();
    const snapshots = new Map<string, unknown>();
    for (const query of queryCache.findAll({ queryKey: nodeKeys.details() })) {
      const data = query.state.data;
      if (data) snapshots.set(JSON.stringify(query.queryKey), data);
    }
    for (const query of queryCache.findAll({ queryKey: nodeKeys.pageContents() })) {
      const data = query.state.data;
      if (data) snapshots.set(JSON.stringify(query.queryKey), data);
    }
    return snapshots;
  }, [queryClient]);

  // Restore snapshots on error
  const restoreSnapshots = useCallback((snapshots: Map<string, unknown>) => {
    for (const [keyStr, data] of snapshots) {
      const key = JSON.parse(keyStr);
      queryClient.setQueryData(key, data);
    }
  }, [queryClient]);

  // Sync a single pending intent
  const syncIntent = useCallback((pending: PendingIntent) => {
    const runtime = getNodeGraphRuntime();
    const { intent, mutationKey } = pending;

    if (coordinator.inFlightMutationKeys.has(mutationKey)) return;
    coordinator.inFlightMutationKeys.add(mutationKey);

    const blockId = (intent as { blockId: string }).blockId;
    const graphNode = runtime.getNode(blockId);
    if (!graphNode?.serverId) {
      coordinator.inFlightMutationKeys.delete(mutationKey);
      return;
    }
    const serverId = graphNode.serverId;

    let parentServerId: number | null = null;
    if (graphNode.parentId) {
      parentServerId = runtime.resolveParentServerId(graphNode.parentId);
    }

    // Snapshot previous cache state for rollback
    const previousSnapshots = snapshotPrevious(serverId);

    // Optimistic cache update via unified helper
    updateNodeInTreeCaches(queryClient, serverId, (node) => ({
      ...node,
      parent_id: parentServerId,
      sequence: graphNode.orderIndex,
    }));

    updateNodeMutation.mutate(
      {
        id: serverId,
        data: {
          parent_id: parentServerId,
          sequence: graphNode.orderIndex,
        },
      },
      {
        onSuccess: () => {
          coordinator.inFlightMutationKeys.delete(mutationKey);
          runtime.consumePendingIntents(mutationKey);

          if (parentServerId != null) {
            queryClient.invalidateQueries({
              queryKey: nodeKeys.detailBase(parentServerId),
            });
          }
        },
        onError: (error) => {
          coordinator.inFlightMutationKeys.delete(mutationKey);
          runtime.unmarkMutationInFlight(mutationKey);

          // Rollback optimistic update
          restoreSnapshots(previousSnapshots);

          if (!isRetryableError(error)) {
            console.error('[useStructureSync] Error syncing node:', error);
            onError?.(blockId, error as Error);
          }
        },
      },
    );
  }, [updateNodeMutation, queryClient, onError, snapshotPrevious, restoreSnapshots]);

  // Scan all pending intents and sync structural ones
  const syncAllPending = useCallback(() => {
    const runtime = getNodeGraphRuntime();
    const allPending = runtime.getAllPendingIntents();

    const structuralTypes = new Set([
      'move_block',
      'indent_block',
      'outdent_block',
      'move_up',
      'move_down',
      'reorder_blocks',
    ]);

    const syncedBlockIds: string[] = [];

    for (const pending of allPending) {
      if (!structuralTypes.has(pending.intent.type)) continue;
      const blockId = (pending.intent as { blockId: string }).blockId;
      syncIntent(pending);
      syncedBlockIds.push(blockId);
    }

    if (syncedBlockIds.length > 0) {
      onSynced?.(syncedBlockIds);
    }
  }, [syncIntent, onSynced]);

  // Flush any pending changes immediately
  const flush = useCallback(() => {
    if (coordinator.debounceTimeout) {
      clearTimeout(coordinator.debounceTimeout);
      coordinator.debounceTimeout = null;
    }
    syncAllPending();
  }, [syncAllPending]);

  // Subscribe to runtime structure changes
  useEffect(() => {
    if (!enabled) return;

    const instanceId = instanceIdRef.current;

    if (coordinator.activeInstanceId === null) {
      coordinator.activeInstanceId = instanceId;
    }

    if (coordinator.activeInstanceId !== instanceId) {
      return;
    }

    const runtime = getNodeGraphRuntime();

    const unsubscribe = runtime.subscribe((event) => {
      if (event.type === 'structure_changed' && event.source === 'intent') {
        if (coordinator.debounceTimeout) {
          clearTimeout(coordinator.debounceTimeout);
        }
        coordinator.debounceTimeout = setTimeout(() => {
          coordinator.debounceTimeout = null;
          syncAllPending();
        }, delay);
      }
      if (event.type === 'flush_intents_requested') {
        flush();
      }
    });

    syncAllPending();

    return () => {
      if (coordinator.debounceTimeout) {
        clearTimeout(coordinator.debounceTimeout);
        coordinator.debounceTimeout = null;
      }
      unsubscribe();
      if (coordinator.activeInstanceId === instanceId) {
        coordinator.activeInstanceId = null;
      }
    };
  }, [enabled, delay, syncAllPending, flush]);

  return { flush };
}
