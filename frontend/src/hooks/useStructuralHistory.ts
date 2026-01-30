/**
 * useStructuralHistory - Hook for undo/redo of structural block operations
 * 
 * Provides a simple API for tracking and reversing structural operations:
 * - Automatically captures before/after state
 * - Integrates with API mutations for undo/redo
 * - Handles selection restoration
 * 
 * Usage:
 * ```tsx
 * const { trackOperation, undo, redo, canUndo, canRedo } = useStructuralHistory();
 * 
 * const handleSplit = async () => {
 *   await trackOperation({
 *     type: 'split',
 *     description: 'Split block',
 *     affectedBlockIds: [blockId],
 *     operation: async (captureAfter) => {
 *       const newBlock = await createNode(...);
 *       await updateNode(...);
 *       captureAfter([blockId, newBlock.id], { createdIds: [newBlock.id] });
 *     },
 *   });
 * };
 * ```
 */
import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { 
  useHistoryStore, 
  useHistoryActions, 
  useHistoryAvailability,
  type HistoryOperationType,
  type NodeSnapshot,
} from '@/stores/historyStore';
import { useEditorSelectionActions } from '@/stores/selectors';
import { useBlockSelectionStore } from '@/stores';
import { nodeKeys } from '@/hooks/queryKeys';
import { updateNode, createNode, deleteNode } from '@/api/nodes';
import type { Node } from '@/types';

/**
 * Options for tracking an operation
 */
interface TrackOperationOptions {
  /** Type of operation */
  type: HistoryOperationType;
  
  /** Human-readable description */
  description: string;
  
  /** Block IDs that will be affected (for capturing before state) */
  affectedBlockIds: number[];
  
  /** 
   * The operation to perform. Receives a captureAfter callback
   * that MUST be called with the final affected block IDs.
   */
  operation: (captureAfter: CaptureAfterFn) => Promise<void>;
}

type CaptureAfterFn = (
  finalBlockIds: number[],
  options?: {
    createdIds?: number[];
    deletedSnapshots?: NodeSnapshot[];
  }
) => void;

/**
 * Convert a Node to a snapshot for history storage
 */
function nodeToSnapshot(node: Node): NodeSnapshot {
  return {
    id: node.id,
    name: node.name,
    parent_id: node.parent_id,
    order_index: node.sequence, // Node uses 'sequence', snapshot uses 'order_index'
  };
}

/**
 * Hook for structural operation history
 */
export function useStructuralHistory() {
  const queryClient = useQueryClient();
  const { pushEntry, undo: undoStore, redo: redoStore, completeUndoRedo } = useHistoryActions();
  const { canUndo, canRedo } = useHistoryAvailability();
  const { setPendingCaret } = useEditorSelectionActions();
  const editorSelection = useBlockSelectionStore(state => state.editorSelection);
  const pendingSelection = useBlockSelectionStore(state => state.pendingSelection);

  /**
   * Get current snapshots for given block IDs from the query cache
   */
  const getSnapshots = useCallback((blockIds: number[]): NodeSnapshot[] => {
    const snapshots: NodeSnapshot[] = [];
    
    for (const blockId of blockIds) {
      // Try to get from cache
      const cached = queryClient.getQueryData<Node>(nodeKeys.detail(blockId));
      if (cached) {
        snapshots.push(nodeToSnapshot(cached));
      }
    }
    
    return snapshots;
  }, [queryClient]);

  /**
   * Get current selection state
   */
  const getCurrentSelection = useCallback(() => {
    return editorSelection || pendingSelection || null;
  }, [editorSelection, pendingSelection]);

  /**
   * Track a structural operation with before/after state
   */
  const trackOperation = useCallback(async (options: TrackOperationOptions) => {
    const { type, description, affectedBlockIds, operation } = options;
    
    // Capture BEFORE state
    const beforeSnapshots = getSnapshots(affectedBlockIds);
    const beforeSelection = getCurrentSelection();
    
    // State to be filled by the operation
    let afterSnapshots: NodeSnapshot[] = [];
    let afterSelection = getCurrentSelection();
    let createdNodeIds: number[] = [];
    let deletedNodeSnapshots: NodeSnapshot[] = [];
    
    // Callback for the operation to report final state
    const captureAfter: CaptureAfterFn = (finalBlockIds, opts) => {
      afterSnapshots = getSnapshots(finalBlockIds);
      afterSelection = getCurrentSelection();
      createdNodeIds = opts?.createdIds || [];
      deletedNodeSnapshots = opts?.deletedSnapshots || [];
    };
    
    // Execute the operation
    await operation(captureAfter);
    
    // Push to history
    pushEntry({
      type,
      description,
      before: {
        nodes: beforeSnapshots,
        selection: beforeSelection,
      },
      after: {
        nodes: afterSnapshots,
        createdNodeIds,
        deletedNodeSnapshots,
        selection: afterSelection,
      },
    });
  }, [getSnapshots, getCurrentSelection, pushEntry]);

  /**
   * Undo the last operation
   * Returns true if undo was performed, false otherwise
   */
  const undo = useCallback(async (): Promise<boolean> => {
    const entry = undoStore();
    if (!entry) return false;
    
    try {
      // Restore nodes to their "before" state
      // 1. Delete any nodes that were created during the operation
      if (entry.after.createdNodeIds && entry.after.createdNodeIds.length > 0) {
        for (const nodeId of entry.after.createdNodeIds) {
          try {
            await deleteNode(nodeId);
          } catch (error) {
            console.error(`[History] Failed to delete created node ${nodeId}:`, error);
          }
        }
      }
      
      // 2. Recreate any nodes that were deleted during the operation
      if (entry.after.deletedNodeSnapshots && entry.after.deletedNodeSnapshots.length > 0) {
        for (const snapshot of entry.after.deletedNodeSnapshots) {
          try {
            await createNode({
              name: snapshot.name,
              parent_id: snapshot.parent_id,
              sequence: snapshot.order_index,
            });
          } catch (error) {
            console.error(`[History] Failed to recreate deleted node:`, error);
          }
        }
      }
      
      // 3. Restore modified nodes to their before state
      for (const snapshot of entry.before.nodes) {
        try {
          await updateNode({
            id: snapshot.id,
            data: {
              name: snapshot.name,
              parent_id: snapshot.parent_id,
              sequence: snapshot.order_index,
            },
          });
        } catch (error) {
          console.error(`[History] Failed to restore node ${snapshot.id}:`, error);
        }
      }
      
      // Invalidate affected nodes to refetch
      for (const snapshot of entry.before.nodes) {
        queryClient.invalidateQueries({ queryKey: nodeKeys.detailBase(snapshot.id) });
      }
      
      // Restore selection
      if (entry.before.selection) {
        setPendingCaret(
          entry.before.selection.anchorBlockId,
          entry.before.selection.anchorOffset,
          entry.before.selection.caretX
        );
      }
      
      completeUndoRedo();
      return true;
    } catch (error) {
      console.error('[History] Undo failed:', error);
      completeUndoRedo();
      return false;
    }
  }, [undoStore, queryClient, setPendingCaret, completeUndoRedo]);

  /**
   * Redo the last undone operation
   * Returns true if redo was performed, false otherwise
   */
  const redo = useCallback(async (): Promise<boolean> => {
    const entry = redoStore();
    if (!entry) return false;
    
    try {
      // Replay the operation: restore to "after" state
      // 1. Recreate any nodes that were created during the original operation
      if (entry.after.createdNodeIds && entry.after.createdNodeIds.length > 0) {
        for (const nodeId of entry.after.createdNodeIds) {
          // Find the snapshot for this created node
          const snapshot = entry.after.nodes.find(n => n.id === nodeId);
          if (snapshot) {
            try {
              await createNode({
                name: snapshot.name,
                parent_id: snapshot.parent_id,
                sequence: snapshot.order_index,
              });
            } catch (error) {
              console.error(`[History] Failed to recreate node ${nodeId}:`, error);
            }
          }
        }
      }
      
      // 2. Delete any nodes that were deleted during the original operation
      if (entry.after.deletedNodeSnapshots && entry.after.deletedNodeSnapshots.length > 0) {
        for (const snapshot of entry.after.deletedNodeSnapshots) {
          try {
            await deleteNode(snapshot.id);
          } catch (error) {
            console.error(`[History] Failed to delete node ${snapshot.id}:`, error);
          }
        }
      }
      
      // 3. Restore modified nodes to their after state
      for (const snapshot of entry.after.nodes) {
        // Skip nodes that were created (already handled above)
        if (entry.after.createdNodeIds?.includes(snapshot.id)) {
          continue;
        }
        
        try {
          await updateNode({
            id: snapshot.id,
            data: {
              name: snapshot.name,
              parent_id: snapshot.parent_id,
              sequence: snapshot.order_index,
            },
          });
        } catch (error) {
          console.error(`[History] Failed to restore node ${snapshot.id}:`, error);
        }
      }
      
      // Invalidate affected nodes to refetch
      for (const snapshot of entry.after.nodes) {
        queryClient.invalidateQueries({ queryKey: nodeKeys.detailBase(snapshot.id) });
      }
      
      // Restore selection
      if (entry.after.selection) {
        setPendingCaret(
          entry.after.selection.anchorBlockId,
          entry.after.selection.anchorOffset,
          entry.after.selection.caretX
        );
      }
      
      completeUndoRedo();
      return true;
    } catch (error) {
      console.error('[History] Redo failed:', error);
      completeUndoRedo();
      return false;
    }
  }, [redoStore, queryClient, setPendingCaret, completeUndoRedo]);

  /**
   * Get debug info
   */
  const getHistoryInfo = useCallback(() => {
    return useHistoryStore.getState().getHistoryInfo();
  }, []);

  return {
    trackOperation,
    undo,
    redo,
    canUndo,
    canRedo,
    getHistoryInfo,
  };
}

export default useStructuralHistory;
