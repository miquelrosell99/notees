/**
 * useBlockPersist — Persists new runtime blocks to the backend API.
 *
 * When the Lexical editor creates a block optimistically via
 * `runtime.applyIntent({ type: 'create_block' })`, the resulting
 * GraphNode has no `serverId`. This hook:
 *
 * 1. Listens for `structure_changed` / `nodes_changed` events
 * 2. Finds GraphNodes without a `serverId`
 * 3. Calls the create-node API to persist them
 * 4. Writes the returned `serverId` back to the runtime
 * 5. Flushes any queued content saves that were blocked on persistence
 *
 * Uses a singleton pattern (like useStructureSync) — only one active
 * instance processes events at a time.
 *
 * Usage:
 * ```tsx
 * function BlockEditor() {
 *   useBlockPersist();   // alongside useStructureSync()
 *   // ...
 * }
 * ```
 */
import { useEffect, useRef, useCallback } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { getNodeGraphRuntime } from '../runtime/NodeGraphRuntime';
import { createNode as createNodeApi, updateNode as updateNodeApi, batchDeleteNodes as batchDeleteNodesApi } from '@/api/nodes';
import type { NodeCreate, Node } from '@/types/api';
import { parseAST, convertMarkdownInAST } from '@/lib/astBuilder';
import { nodeKeys } from './queryKeys';
import { removeNodeFromTreeImmutable } from '@/utils/nodeTree';

// ─── Singleton state ──────────────────────────────────────────────

let activeInstanceId: string | null = null;

/**
 * Set of blockIds currently being persisted (in-flight API calls).
 * Prevents duplicate persist attempts for the same block.
 */
const inFlightBlocks = new Set<string>();

/**
 * Queued content saves: blockId (UUID) → latest content string.
 * When a content change fires for a block without serverId, we store
 * it here and flush it once the serverId arrives.
 */
const pendingContentSaves = new Map<string, string>();

/** Register a content save to flush after the block gets a serverId */
export function queueContentSave(blockId: string, content: string): void {
  pendingContentSaves.set(blockId, content);
}

/** Check if a block is currently being persisted or queued */
export function isBlockPending(blockId: string): boolean {
  return inFlightBlocks.has(blockId) || pendingContentSaves.has(blockId);
}

/**
 * Pending batch delete: collects block UUIDs from block_deleted events
 * within one microtask and flushes them as a single batchDeleteNodes call.
 */
let pendingDeleteUuids: string[] = [];
let deleteFlushScheduled = false;

function scheduleDeleteFlush(): void {
  if (deleteFlushScheduled) return;
  deleteFlushScheduled = true;
  queueMicrotask(() => {
    deleteFlushScheduled = false;
    const uuids = pendingDeleteUuids;
    pendingDeleteUuids = [];
    if (uuids.length === 0) return;
    if (uuids.length === 1) {
      // Single delete — use the simpler endpoint (identified by server id not available here,
      // so use batch with single uuid)
      batchDeleteNodesApi({ uuids }).catch((error) => {
        console.error('[useBlockPersist] Failed to batch-delete blocks:', error);
      });
    } else {
      batchDeleteNodesApi({ uuids }).catch((error) => {
        console.error('[useBlockPersist] Failed to batch-delete blocks:', error);
      });
    }
  });
}

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

          // Write serverId back to runtime
          runtime.setServerId(blockId, createdNode.id);

          onPersisted?.(blockId, createdNode.id);

          // Invalidate parent node's cache so it includes the new child.
          // The reconciliation in apiNodesToGraphNodes ensures the refetched
          // data maps the server UUID back to the runtime's blockId, preventing
          // a visual flash (remove old + add new) in the editor.
          if (parentServerId != null) {
            queryClient.invalidateQueries({
              queryKey: nodeKeys.detailBase(parentServerId),
            });
          }

          // Flush any queued content save for this block
          const queuedContent = pendingContentSaves.get(blockId);
          if (queuedContent != null) {
            pendingContentSaves.delete(blockId);
            // Now that we have a serverId, save content directly via API
            flushQueuedContent(createdNode.id, queuedContent);
          }

          // Now check if any children were waiting on this parent
          const children = runtime.getChildren(blockId);
          for (const child of children) {
            if (child.serverId == null) {
              persistBlock(child.blockId);
            }
          }
        },
        onError: (error) => {
          inFlightBlocks.delete(blockId);
          console.error('[useBlockPersist] Failed to persist block:', blockId, error);
          onError?.(blockId, error as Error);
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
      activeInstanceId = instanceId;
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
        for (const query of queryCache.findAll({ queryKey: ['nodes', 'page-content'] })) {
          const oldData = query.state.data as Node | undefined;
          if (oldData) {
            const newData = removeNode(oldData);
            if (newData !== oldData) queryClient.setQueryData(query.queryKey, newData);
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
        activeInstanceId = null;
      }
    };
  }, [enabled, persistAll]);
}

// ─── Helpers ──────────────────────────────────────────────────────

/**
 * Serialize a ContentAST to a string suitable for the `name` field.
 * For newly-created blocks this is typically empty or minimal.
 */
function serializeContentForAPI(contentAST: import('../runtime/types').ContentAST): string {
  if (!contentAST || contentAST.length === 0) return '';

  // Check if it's just an empty paragraph
  const isEffectivelyEmpty = contentAST.length === 1 &&
    contentAST[0].children.length <= 1 &&
    (!contentAST[0].children[0] || 
      ('text' in contentAST[0].children[0] && contentAST[0].children[0].text === ''));

  if (isEffectivelyEmpty) return '';

  // For non-empty content, serialize as JSON AST (the format the backend expects)
  return JSON.stringify(contentAST);
}

/**
 * Flush a queued content save now that the block has a serverId.
 * Calls the update API directly — converts markdown syntax in AST first.
 */
function flushQueuedContent(serverId: number, content: string): void {
  // Match the same conversion logic as useContentSave.saveBlock
  const ast = parseAST(content);
  const converted = convertMarkdownInAST(ast);
  const finalContent = converted !== ast ? JSON.stringify(converted) : content;

  updateNodeApi(serverId, { name: finalContent }).catch((error) => {
    console.error('[useBlockPersist] Failed to flush content for serverId:', serverId, error);
  });
}
