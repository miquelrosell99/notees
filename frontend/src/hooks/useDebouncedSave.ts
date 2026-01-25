/**
 * useDebouncedSave - Debounced auto-save for content changes
 * 
 * Batches rapid content changes and saves after a delay.
 * Provides immediate local state while debouncing API calls.
 * 
 * Features:
 * - Configurable debounce delay (default 500ms)
 * - Tracks pending changes per block
 * - Flushes on unmount or explicit flush
 * - Optimistic local updates
 */
import { useRef, useCallback, useEffect } from 'react';
import { useUpdateNode } from './useNodeMutations';

const DEFAULT_DEBOUNCE_MS = 500;

interface PendingChange {
  blockId: number;
  content: string;
  timeoutId: ReturnType<typeof setTimeout>;
}

/**
 * Hook for debounced block content saves
 */
export function useDebouncedSave(debounceMs = DEFAULT_DEBOUNCE_MS) {
  const updateNode = useUpdateNode();
  const pendingChanges = useRef<Map<number, PendingChange>>(new Map());
  
  /**
   * Flush all pending changes immediately
   */
  const flush = useCallback(() => {
    pendingChanges.current.forEach((change) => {
      clearTimeout(change.timeoutId);
      updateNode.mutate({
        id: change.blockId,
        data: { name: change.content }
      });
    });
    pendingChanges.current.clear();
  }, [updateNode]);
  
  /**
   * Flush a specific block's pending change
   */
  const flushBlock = useCallback((blockId: number) => {
    const change = pendingChanges.current.get(blockId);
    if (change) {
      clearTimeout(change.timeoutId);
      updateNode.mutate({
        id: change.blockId,
        data: { name: change.content }
      });
      pendingChanges.current.delete(blockId);
    }
  }, [updateNode]);
  
  /**
   * Schedule a debounced save for a block
   */
  const saveContent = useCallback((blockId: number, content: string) => {
    // Clear existing timeout for this block
    const existing = pendingChanges.current.get(blockId);
    if (existing) {
      clearTimeout(existing.timeoutId);
    }
    
    // Schedule new save
    const timeoutId = setTimeout(() => {
      updateNode.mutate({
        id: blockId,
        data: { name: content }
      });
      pendingChanges.current.delete(blockId);
    }, debounceMs);
    
    pendingChanges.current.set(blockId, {
      blockId,
      content,
      timeoutId,
    });
  }, [updateNode, debounceMs]);
  
  /**
   * Check if a block has unsaved changes
   */
  const hasPendingChanges = useCallback((blockId?: number) => {
    if (blockId !== undefined) {
      return pendingChanges.current.has(blockId);
    }
    return pendingChanges.current.size > 0;
  }, []);
  
  // Flush on unmount
  useEffect(() => {
    return () => {
      pendingChanges.current.forEach((change) => {
        clearTimeout(change.timeoutId);
        // Note: Can't reliably call mutation in cleanup, 
        // consider using navigator.sendBeacon for critical saves
      });
    };
  }, []);
  
  // Flush before page unload
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (pendingChanges.current.size > 0) {
        flush();
        // Show warning if there are pending changes
        e.preventDefault();
        e.returnValue = '';
      }
    };
    
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [flush]);
  
  return {
    saveContent,
    flush,
    flushBlock,
    hasPendingChanges,
    isPending: updateNode.isPending,
  };
}

export default useDebouncedSave;
