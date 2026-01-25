/**
 * useBlockOperation - Hook for safe structural block operations
 * 
 * Provides protection against race conditions when performing structural
 * operations like split, merge, indent, outdent, move, or delete.
 * 
 * Usage:
 * ```tsx
 * const { wrapOperation, isOperationPending } = useBlockOperation();
 * 
 * const handleSplit = useCallback(async () => {
 *   await wrapOperation('split', [blockId], async () => {
 *     // Your mutation logic here
 *     await createNode(...);
 *     await updateNode(...);
 *   });
 * }, [blockId, wrapOperation]);
 * ```
 */
import { useCallback } from 'react';
import { useOperationQueueActions } from '@/stores/selectors';
import type { OperationQueueEntry } from '@/stores';

type OperationType = OperationQueueEntry['type'];

/**
 * Hook for coordinating structural block operations
 */
export function useBlockOperation() {
  const { 
    startOperation, 
    hasBlockingOperation, 
    waitForOperations,
    getPendingOperations 
  } = useOperationQueueActions();

  /**
   * Wrap an async operation to coordinate with other operations.
   * 
   * 1. Waits for any pending operations on the affected blocks
   * 2. Registers the operation in the queue
   * 3. Executes the operation
   * 4. Auto-removes from queue on completion
   * 
   * @param type - Type of operation for debugging
   * @param blockIds - Block IDs affected by this operation
   * @param fn - The async operation to execute
   */
  const wrapOperation = useCallback(async <T>(
    type: OperationType,
    blockIds: number[],
    fn: () => Promise<T>
  ): Promise<T> => {
    // Wait for any existing operations on these blocks
    await waitForOperations(blockIds);
    
    // Create a promise that we control
    let resolve: () => void;
    let reject: (error: unknown) => void;
    const operationPromise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    
    // Register the operation
    startOperation(type, blockIds, operationPromise);
    
    try {
      // Execute the actual operation
      const result = await fn();
      resolve!();
      return result;
    } catch (error) {
      reject!(error);
      throw error;
    }
  }, [startOperation, waitForOperations]);

  /**
   * Check if there's a pending operation on any of the given blocks
   */
  const isOperationPending = useCallback((blockIds: number[]): boolean => {
    return hasBlockingOperation(blockIds);
  }, [hasBlockingOperation]);

  /**
   * Get debug info about pending operations
   */
  const debugPendingOperations = useCallback(() => {
    const pending = getPendingOperations();
    console.log('[BlockOperation] Pending operations:', pending.map(op => ({
      id: op.id,
      type: op.type,
      blockIds: op.blockIds,
      duration: Date.now() - op.startTime,
    })));
    return pending;
  }, [getPendingOperations]);

  return {
    wrapOperation,
    isOperationPending,
    waitForOperations,
    debugPendingOperations,
  };
}

export default useBlockOperation;
