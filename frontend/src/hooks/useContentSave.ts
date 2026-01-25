/**
 * useContentSave - Debounced content save hook for block editing
 * 
 * Provides a debounced content change handler that batches rapid
 * content updates to reduce API calls. Used in views that contain
 * editable blocks (NodeView, NodeDocumentView, NodeListView, etc.).
 * 
 * Features:
 * - Debounces content changes (500ms default)
 * - Per-block tracking (doesn't interfere across blocks)
 * - Auto-flush on unmount
 * - Manual flush capability
 * - Optimistic UI (content updates immediately)
 * 
 * Usage:
 * ```tsx
 * function MyView() {
 *   const { handleContentChange, flushAll } = useContentSave();
 *   
 *   // Use handleContentChange as the onContentChange prop for Block
 *   return <Block onContentChange={handleContentChange} ... />;
 * }
 * ```
 */
import { useCallback, useRef, useEffect } from 'react';
import { useUpdateNode } from './useNodes';

/** Pending change entry */
interface PendingChange {
  blockId: number;
  content: string;
  timeoutId: ReturnType<typeof setTimeout>;
}

interface UseContentSaveOptions {
  /** Debounce delay in ms (default: 500) */
  delay?: number;
  /** Called after successful save */
  onSaved?: (blockId: number) => void;
  /** Called on save error */
  onError?: (blockId: number, error: Error) => void;
}

/**
 * Hook for debounced content saving
 */
export function useContentSave(options: UseContentSaveOptions = {}) {
  const { delay = 500, onSaved, onError } = options;
  const updateNode = useUpdateNode();
  
  // Track pending changes per block
  const pendingChangesRef = useRef<Map<number, PendingChange>>(new Map());
  
  // Save a specific block
  const saveBlock = useCallback((blockId: number, content: string) => {
    updateNode.mutate(
      { id: blockId, data: { name: content } },
      {
        onSuccess: () => onSaved?.(blockId),
        onError: (error) => onError?.(blockId, error as Error),
      }
    );
  }, [updateNode, onSaved, onError]);
  
  // Flush a specific block
  const flushBlock = useCallback((blockId: number) => {
    const pending = pendingChangesRef.current.get(blockId);
    if (pending) {
      clearTimeout(pending.timeoutId);
      pendingChangesRef.current.delete(blockId);
      saveBlock(blockId, pending.content);
    }
  }, [saveBlock]);
  
  // Flush all pending changes
  const flushAll = useCallback(() => {
    pendingChangesRef.current.forEach((pending, blockId) => {
      clearTimeout(pending.timeoutId);
      saveBlock(blockId, pending.content);
    });
    pendingChangesRef.current.clear();
  }, [saveBlock]);
  
  // Cancel pending change for a block (without saving)
  const cancel = useCallback((blockId: number) => {
    const pending = pendingChangesRef.current.get(blockId);
    if (pending) {
      clearTimeout(pending.timeoutId);
      pendingChangesRef.current.delete(blockId);
    }
  }, []);
  
  // Cancel all pending changes (without saving)
  const cancelAll = useCallback(() => {
    pendingChangesRef.current.forEach((pending) => {
      clearTimeout(pending.timeoutId);
    });
    pendingChangesRef.current.clear();
  }, []);
  
  // Main content change handler (debounced)
  const handleContentChange = useCallback((blockId: number, content: string) => {
    // Clear existing timeout for this block
    const existing = pendingChangesRef.current.get(blockId);
    if (existing) {
      clearTimeout(existing.timeoutId);
    }
    
    // Set new debounced save
    const timeoutId = setTimeout(() => {
      pendingChangesRef.current.delete(blockId);
      saveBlock(blockId, content);
    }, delay);
    
    pendingChangesRef.current.set(blockId, {
      blockId,
      content,
      timeoutId,
    });
  }, [delay, saveBlock]);
  
  // Immediate save (bypasses debounce)
  const saveImmediate = useCallback((blockId: number, content: string) => {
    // Cancel any pending debounced save
    cancel(blockId);
    // Save immediately
    saveBlock(blockId, content);
  }, [cancel, saveBlock]);
  
  // Check if there are pending changes
  const hasPendingChanges = useCallback((blockId?: number) => {
    if (blockId !== undefined) {
      return pendingChangesRef.current.has(blockId);
    }
    return pendingChangesRef.current.size > 0;
  }, []);
  
  // Flush on unmount
  useEffect(() => {
    return () => {
      pendingChangesRef.current.forEach((pending, blockId) => {
        clearTimeout(pending.timeoutId);
        // Save synchronously on unmount
        saveBlock(blockId, pending.content);
      });
      pendingChangesRef.current.clear();
    };
  }, [saveBlock]);
  
  // Flush on beforeunload (page close/refresh)
  useEffect(() => {
    const handleBeforeUnload = () => {
      flushAll();
    };
    
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [flushAll]);
  
  return {
    /** Debounced content change handler - use as onContentChange prop */
    handleContentChange,
    /** Save immediately without debounce */
    saveImmediate,
    /** Flush pending changes for a specific block */
    flushBlock,
    /** Flush all pending changes */
    flushAll,
    /** Cancel pending change without saving */
    cancel,
    /** Cancel all pending changes without saving */
    cancelAll,
    /** Check for pending changes */
    hasPendingChanges,
    /** Whether any mutation is in progress */
    isSaving: updateNode.isPending,
  };
}

export default useContentSave;
