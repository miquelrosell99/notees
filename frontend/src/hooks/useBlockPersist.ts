/**
 * useBlockPersist — Persists new runtime blocks to the backend API.
 */

import { useEffect, useRef, useCallback } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { getNodeGraphRuntime } from '../runtime/NodeGraphRuntime';
import { createNode as createNodeApi } from '@/api/nodes';
import type { NodeCreate, Node, LinkedReference, PropertyBacklink } from '@/types/api';
import { nodeKeys } from './queryKeys';
import { removeNodeFromTreeImmutable } from '@/utils/nodeTree';
import { offlineQueue } from '@/lib/offlineQueue';
import {
  activeInstanceId,
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
} from './useBlockPersist.utils';

// Re-export utility functions for consumers
export { queueContentSave, isBlockPending };

// ─── Hook ─────────────────────────────────────────────────────────

interface UseBlockPersistOptions {
  /** When false, the hook becomes a no-op (no singleton claim, no subscriptions). Used by draft-mode editors. */
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

  // Persist a single unpersisted block
  const persistBlock = useCallback((blockId: string) => {
    if (inFlightBlocks.has(blockId)) return; // Already in-flight

    const runtime = getNodeGraphRuntime();
    const graphNode = runtime.getNode(blockId);
    if (!graphNode) return;
    if (graphNode.serverId != null) return; // Already persisted

    // Resolve parent's serverId
    let parentServerId: number | null = null;
    if (graphNode.parentId) {
      // Try resolveParentServerId which checks both full nodes and the lightweight mapping
      parentServerId = runtime.resolveParentServerId(graphNode.parentId);
      if (parentServerId == null) {
        // Parent isn't persisted yet — it will trigger us when it is
        return;
      }
    }

    inFlightBlocks.add(blockId);

    // Serialize content for API
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

          // Remap the runtime block from the client-generated UUID to the
          // server's UUID so that focused-view navigation (which resolves
          // rootBlockId from node.uuid) finds the correct runtime node.
          // Without this, the project() call uses the server UUID as root
          // but the runtime still stores the node under the old client UUID,
          // resulting in an empty projection (blank focused view).
          //
          // IMPORTANT: Set serverId BEFORE remapBlockId. remapBlockId emits
          // a synchronous structure_changed event which triggers persistAll().
          // If serverId isn't set yet, the block appears unpersisted under
          // its new UUID and gets created a second time.
          runtime.setServerId(blockId, createdNode.id);
          runtime.remapBlockId(blockId, createdNode.uuid);

          const newBlockId = createdNode.uuid;
          onPersisted?.(newBlockId, createdNode.id);

          // ── Optimistic cache insertion ──
          // Insert the created block into parent detail query caches now.
          // Without this, a concurrent mutation (e.g. useUpdateNode's
          // debounced content save) can cancel the invalidation refetch
          // via cancelQueries while its setQueryData writes cache data
          // that omits the new block.  BlockEditor's useLayoutEffect
          // cleanup then removes the block from the runtime (it has a
          // serverId but isn't in the cache), making it vanish until
          // page reload.
          if (parentServerId != null) {
            const insertCreatedBlock = (node: Node | undefined): Node | undefined => {
              if (!node) return node;
              if (node.id === parentServerId) {
                const existing = node.children || [];
                if (existing.some(c => c.id === createdNode.id)) return node;
                const insertIdx = existing.findIndex(c => (c.sequence ?? 0) > (createdNode.sequence ?? 0));
                const newChildren = insertIdx === -1
                  ? [...existing, { ...createdNode, children: [] }]
                  : [...existing.slice(0, insertIdx), { ...createdNode, children: [] }, ...existing.slice(insertIdx)];
                return { ...node, children: newChildren };
              }
              if (node.children && node.children.length > 0) {
                let changed = false;
                const newChildren = node.children.map(child => {
                  const updated = insertCreatedBlock(child);
                  if (updated !== child) changed = true;
                  return updated!;
                });
                if (changed) return { ...node, children: newChildren };
              }
              return node;
            };

            const qCache = queryClient.getQueryCache();
            for (const query of qCache.findAll({ queryKey: nodeKeys.details() })) {
              const oldData = query.state.data as Node | undefined;
              if (oldData) {
                const newData = insertCreatedBlock(oldData);
                if (newData !== oldData) queryClient.setQueryData(query.queryKey, newData);
              }
            }
            for (const query of qCache.findAll({ queryKey: nodeKeys.pageContents() })) {
              const oldData = query.state.data as Node | undefined;
              if (oldData) {
                const newData = insertCreatedBlock(oldData);
                if (newData !== oldData) queryClient.setQueryData(query.queryKey, newData);
              }
            }
            // Also update byUuid queries (e.g. Scratchpad uses useNodeByUuid with include_children)
            for (const query of qCache.findAll({ queryKey: nodeKeys.uuids() })) {
              const oldData = query.state.data as Node | undefined;
              if (oldData) {
                const newData = insertCreatedBlock(oldData);
                if (newData !== oldData) queryClient.setQueryData(query.queryKey, newData);
              }
            }
          }

          // Flush any queued content save for this block BEFORE invalidating
          // caches. This ensures that when the parent cache refetches, the
          // block's content is already saved to the server.
          const queuedContent = pendingContentSaves.get(blockId);
          if (queuedContent != null) {
            pendingContentSaves.delete(blockId);
            // Save content first, then invalidate caches so refetches get fresh data
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
            // No queued content — invalidate parent cache immediately
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
              persistBlock(child.blockId);
            }
          }
        },
        onError: (error) => {
          inFlightBlocks.delete(blockId);
          if (isRetryableError(error)) {
            offlineQueue.enqueue({
              type: 'create_block',
              parentBlockUuid: graphNode.parentId || '__root__',
              name,
              sequence: graphNode.orderIndex,
            }).catch(console.error);
          } else {
            console.error('[useBlockPersist] Failed to persist block:', blockId, error);
            onError?.(blockId, error as Error);
          }
        },
      },
    );
  }, [createNodeMutation, onPersisted, onError]);

  // Scan for all unpersisted nodes and persist them
  const persistAll = useCallback(() => {
    const runtime = getNodeGraphRuntime();
    const unpersisted = runtime.getUnpersistedNodes();

    for (const node of unpersisted) {
      persistBlock(node.blockId);
    }
  }, [persistBlock]);

  // Subscribe to runtime events
  useEffect(() => {
    if (!enabled) return;

    const instanceId = instanceIdRef.current;

    if (activeInstanceId === null) {
      setActiveInstanceId(instanceId);
    }

    if (activeInstanceId !== instanceId) return;

    const runtime = getNodeGraphRuntime();

    const unsubscribe = runtime.subscribe((event) => {
      if (event.type === 'structure_changed' || event.type === 'nodes_changed') {
        // Check for unpersisted nodes after any mutation
        persistAll();
      }
      if (event.type === 'block_deleted' && event.serverId != null) {
        const deletedServerId = event.serverId;
        
        // Optimistically remove deleted node from query cache
        const removeNode = (oldNode: Node | undefined): Node | undefined => {
          if (!oldNode) return oldNode;
          if (oldNode.id === deletedServerId) return oldNode;
          if (oldNode.children && oldNode.children.length > 0) {
            const newChildren = removeNodeFromTreeImmutable(oldNode.children, deletedServerId);
            if (newChildren !== oldNode.children) {
              return { ...oldNode, children: newChildren };
            }
          }
          return oldNode;
        };
        
        const queryCache = queryClient.getQueryCache();
        for (const query of queryCache.findAll({ queryKey: nodeKeys.details() })) {
          const oldData = query.state.data as Node | undefined;
          if (oldData) {
            const newData = removeNode(oldData);
            if (newData !== oldData) queryClient.setQueryData(query.queryKey, newData);
          }
        }
        for (const query of queryCache.findAll({ queryKey: nodeKeys.pageContents() })) {
          const oldData = query.state.data as Node | undefined;
          if (oldData) {
            const newData = removeNode(oldData);
            if (newData !== oldData) queryClient.setQueryData(query.queryKey, newData);
          }
        }
        // Also update byUuid queries (e.g. Scratchpad uses useNodeByUuid with include_children)
        for (const query of queryCache.findAll({ queryKey: nodeKeys.uuids() })) {
          const oldData = query.state.data as Node | undefined;
          if (oldData) {
            const newData = removeNode(oldData);
            if (newData !== oldData) queryClient.setQueryData(query.queryKey, newData);
          }
        }

        // Also remove from flat Node[] caches (list views, query sections)
        const flatCacheKeys = [
          ['nodeViews', 'queryResults'],
          nodeKeys.pseudoNodeQuery(),
          nodeKeys.inlineQuery(),
        ] as const;
        for (const keyPrefix of flatCacheKeys) {
          for (const query of queryCache.findAll({ queryKey: keyPrefix })) {
            const oldData = query.state.data as Node[] | undefined;
            if (oldData && Array.isArray(oldData)) {
              const newData = oldData.filter(n => n.id !== deletedServerId);
              if (newData.length !== oldData.length) {
                queryClient.setQueryData(query.queryKey, newData);
              }
            }
          }
        }

        // Optimistically remove from linked-refs caches (different shape: { linked_references, total_count })
        const linkedRefQueries = queryCache.findAll({ queryKey: nodeKeys.allLinkedRefs() });
        for (const query of linkedRefQueries) {
          const oldData = query.state.data as { linked_references: LinkedReference[]; total_count: number } | undefined;
          if (oldData && oldData.linked_references) {
            const newRefs = oldData.linked_references.filter(ref => ref.source_node.id !== deletedServerId);
            if (newRefs.length !== oldData.linked_references.length) {
              queryClient.setQueryData(query.queryKey, {
                ...oldData,
                linked_references: newRefs,
                total_count: Math.max(0, oldData.total_count - 1),
              });
            }
          }
        }

        // Optimistically remove from property-backlinks caches (different shape: PropertyBacklink[])
        const propertyBacklinkQueries = queryCache.findAll({ queryKey: ['nodes', 'property-backlinks'] });
        for (const query of propertyBacklinkQueries) {
          const oldData = query.state.data as PropertyBacklink[] | undefined;
          if (oldData && Array.isArray(oldData)) {
            const newData = oldData.filter(ref => ref.source_page.id !== deletedServerId);
            if (newData.length !== oldData.length) {
              queryClient.setQueryData(query.queryKey, newData);
            }
          }
        }

        // Block was deleted/merged in the editor — batch-persist to API
        pendingDeleteUuids.push(event.blockId);
        scheduleDeleteFlush();
        // Clean up any queued content save for this block
        pendingContentSaves.delete(event.blockId);
        inFlightBlocks.delete(event.blockId);
      }
    });

    // Initial scan for any unpersisted nodes already in the runtime
    persistAll();

    return () => {
      unsubscribe();
      if (activeInstanceId === instanceId) {
        setActiveInstanceId(null);
      }
    };
  }, [enabled, persistAll]);
}
