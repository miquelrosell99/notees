/**
 * useStructureSync - Syncs runtime structural changes to the backend database
 * 
 * Listens to runtime 'structure_changed' events (triggered by indent, outdent, reorder operations)
 * and persists parent_id and sequence changes to the database via API.
 * 
 * IMPORTANT: Uses a custom mutation that skips query invalidation to prevent
 * infinite loops where server data overwrites local runtime state.
 * 
 * Features:
 * - Debounced saves (200ms default for responsive UX)
 * - Batches multiple changes together
 * - Extracts affected nodes from runtime and syncs to API
 * - No query invalidation to preserve runtime state
 * - Singleton pattern - only one active sync per app
 * 
 * Usage:
 * ```tsx
 * function NoteesEditor() {
 *   useStructureSync();
 *   // ... rest of editor
 * }
 * ```
 */
import { useEffect, useRef, useCallback } from 'react';
import { useMutation } from '@tanstack/react-query';
import { getNodeGraphRuntime } from '../runtime/NodeGraphRuntime';
import { updateNode as updateNodeApi } from '@/api/nodes';
import type { NodeUpdate } from '@/types/api';

interface UseStructureSyncOptions {
  /** Debounce delay in ms (default: 200) */
  delay?: number;
  /** Called after successful sync */
  onSynced?: (blockIds: string[]) => void;
  /** Called on sync error */
  onError?: (blockId: string, error: Error) => void;
}

// Global state to ensure only one instance is active
let activeInstanceId: string | null = null;
const pendingChanges = new Set<string>();
let debounceTimeout: ReturnType<typeof setTimeout> | null = null;
// Track nodes that were recently synced to prevent loops
const recentlySynced = new Map<number, number>(); // serverId -> timestamp
const SYNC_COOLDOWN = 1000; // Don't sync same node within 1 second

/**
 * Hook to sync runtime structural changes (parent_id, sequence) to database.
 * 
 * When the runtime emits 'structure_changed' events (from indent, outdent, reorder),
 * this hook extracts the affected nodes and persists their parent_id and sequence
 * to the backend API WITHOUT triggering query invalidation (to prevent loops).
 * 
 * Uses a singleton pattern - only the first mounted instance is active.
 */
export function useStructureSync(options: UseStructureSyncOptions = {}) {
  const { delay = 200, onSynced, onError } = options;
  const instanceIdRef = useRef<string>(Math.random().toString(36));
  
  // Use a custom mutation that DOES NOT invalidate queries
  const updateNodeMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: NodeUpdate }) => 
      updateNodeApi(id, data),
  });

  // Save the structural changes for affected nodes
  const syncNodes = useCallback((blockIds: string[]) => {
    const runtime = getNodeGraphRuntime();
    const now = Date.now();
    
    // Track which nodes we've already queued to avoid duplicates
    const syncedInBatch = new Set<number>();
    
    // Sync each affected node's parent_id and sequence
    blockIds.forEach(blockId => {
      const graphNode = runtime.getNode(blockId);
      if (!graphNode || !graphNode.serverId) return;
      
      // Skip if already synced in this batch
      if (syncedInBatch.has(graphNode.serverId)) return;
      
      // Skip if recently synced (within cooldown period)
      const lastSyncTime = recentlySynced.get(graphNode.serverId);
      if (lastSyncTime && (now - lastSyncTime) < SYNC_COOLDOWN) {
        return;
      }
      
      syncedInBatch.add(graphNode.serverId);
      recentlySynced.set(graphNode.serverId, now);

      // Convert parent blockId to serverId
      let parentServerId: number | null = null;
      if (graphNode.parentId) {
        const parentNode = runtime.getNode(graphNode.parentId);
        parentServerId = parentNode?.serverId ?? null;
      }

      // Update via API (without query invalidation)
      updateNodeMutation.mutate(
        { 
          id: graphNode.serverId, 
          data: { 
            parent_id: parentServerId,
            sequence: graphNode.orderIndex,
          } 
        },
        {
          onError: (error) => {
            console.error('[useStructureSync] Error syncing node:', error);
            onError?.(blockId, error as Error);
            // Clear from recently synced on error so it can retry
            recentlySynced.delete(graphNode.serverId!);
          },
        }
      );
    });

    // Clean up old entries from recentlySynced (older than 2x cooldown)
    for (const [serverId, timestamp] of recentlySynced.entries()) {
      if (now - timestamp > SYNC_COOLDOWN * 2) {
        recentlySynced.delete(serverId);
      }
    }

    onSynced?.(blockIds);
  }, [updateNodeMutation, onSynced, onError]);

  // Flush pending changes
  const flush = useCallback(() => {
    if (debounceTimeout) {
      clearTimeout(debounceTimeout);
      debounceTimeout = null;
    }
    
    if (pendingChanges.size > 0) {
      const blockIds = Array.from(pendingChanges);
      pendingChanges.clear();
      syncNodes(blockIds);
    }
  }, [syncNodes]);

  // Subscribe to runtime structure changes (only if this is the active instance)
  useEffect(() => {
    const instanceId = instanceIdRef.current;
    
    // Register as active instance if none exists
    if (activeInstanceId === null) {
      activeInstanceId = instanceId;
    }
    
    // Only the active instance listens and syncs
    if (activeInstanceId !== instanceId) {
      return;
    }
    
    const runtime = getNodeGraphRuntime();
    
    const unsubscribe = runtime.subscribe((event) => {
      if (event.type === 'structure_changed') {
        // Extract all affected block IDs
        const affectedBlockIds: string[] = [];
        
        // Get children of changed parent(s) to sync their sequence numbers
        event.parentIds.forEach(parentId => {
          const children = runtime.getChildren(parentId);
          children.forEach(child => {
            // Only sync nodes that have server IDs (skip virtual nodes)
            const node = runtime.getNode(child.blockId);
            if (node && node.serverId) {
              affectedBlockIds.push(child.blockId);
            }
          });
        });
        
        if (affectedBlockIds.length > 0) {
          // Add to pending changes
          affectedBlockIds.forEach(id => pendingChanges.add(id));
          
          // Clear existing timeout
          if (debounceTimeout) {
            clearTimeout(debounceTimeout);
          }
          
          // Schedule flush
          debounceTimeout = setTimeout(() => {
            flush();
          }, delay);
        }
      }
    });

    return () => {
      // Flush any pending changes on unmount
      flush();
      unsubscribe();
      
      // Clear active instance if we were it
      if (activeInstanceId === instanceId) {
        activeInstanceId = null;
      }
    };
  }, [delay, flush]);

  return { flush };
}
