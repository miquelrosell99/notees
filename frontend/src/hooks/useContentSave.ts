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
 * - Offline support via runtime pending intents
 */
import { useCallback, useRef, useEffect } from 'react';
import { useUpdateNode } from './useNodes';
import { parseAST, convertMarkdownInAST } from '@/lib/astBuilder';
import { getNodeGraphRuntime } from '@/runtime/NodeGraphRuntime';
import { liveSyncManager } from '@/collab/LiveSyncManager';
import {
  flushRegistry,
  pendingSavePromises,
  flushAllContentSaves,
  awaitAllContentSaves,
} from './contentSaveTracker';

// Re-export so existing imports from '@/hooks/useContentSave' keep working.
export { flushAllContentSaves, awaitAllContentSaves };

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
  const mutateRef = useRef(updateNode.mutateAsync);
  mutateRef.current = updateNode.mutateAsync;

  const pendingChangesRef = useRef<Map<number, PendingChange>>(new Map());
  const lastSavedContentRef = useRef<Map<number, string>>(new Map());

  const saveBlock = useCallback((blockId: number, content: string) => {
    const ast = parseAST(content);
    const converted = convertMarkdownInAST(ast);
    const finalContent = converted !== ast ? JSON.stringify(converted) : content;

    if (lastSavedContentRef.current.get(blockId) === finalContent) return;
    lastSavedContentRef.current.set(blockId, finalContent);

    const runtime = getNodeGraphRuntime();
    const graphNode = runtime.getNodeByServerId(blockId);
    const blockUuid = graphNode?.blockId;

    if (blockUuid && typeof navigator !== 'undefined' && navigator.onLine) {
      try {
        liveSyncManager.sendBlockUpdate(blockUuid, blockId, finalContent);
      } catch {
        // Ignore broadcast errors — REST save is the source of truth
      }
    }

    // Record runtime intent for offline support and undo history
    let mutationKey: string | null = null;
    if (blockUuid) {
      runtime.applyIntent({
        type: 'update_content',
        blockId: blockUuid,
        contentAST: converted,
      }, true);
      const pending = runtime.getPendingIntentsForBlock(blockUuid);
      const contentIntent = pending.find(p => p.intent.type === 'update_content');
      mutationKey = contentIntent?.mutationKey ?? null;
    }

    const promise = mutateRef.current({ id: blockId, data: { name: finalContent } })
      .then(() => {
        onSaved?.(blockId);
        if (blockUuid && mutationKey) {
          runtime.consumePendingIntents(mutationKey);
        }
      })
      .catch((error) => {
        if (blockUuid && mutationKey) {
          runtime.unmarkMutationInFlight(mutationKey);
        }
        onError?.(blockId, error as Error);
      })
      .finally(() => {
        pendingSavePromises.delete(promise);
      });

    pendingSavePromises.add(promise);
  }, [onSaved, onError]);

  const flushBlock = useCallback((blockId: number) => {
    const pending = pendingChangesRef.current.get(blockId);
    if (pending) {
      clearTimeout(pending.timeoutId);
      pendingChangesRef.current.delete(blockId);
      saveBlock(blockId, pending.content);
    }
  }, [saveBlock]);

  const flushAll = useCallback(() => {
    pendingChangesRef.current.forEach((pending, blockId) => {
      clearTimeout(pending.timeoutId);
      saveBlock(blockId, pending.content);
    });
    pendingChangesRef.current.clear();
  }, [saveBlock]);

  const cancel = useCallback((blockId: number) => {
    const pending = pendingChangesRef.current.get(blockId);
    if (pending) {
      clearTimeout(pending.timeoutId);
      pendingChangesRef.current.delete(blockId);
    }
  }, []);

  const cancelAll = useCallback(() => {
    pendingChangesRef.current.forEach((pending) => {
      clearTimeout(pending.timeoutId);
    });
    pendingChangesRef.current.clear();
  }, []);

  const handleContentChange = useCallback((blockId: number, content: string) => {
    const existing = pendingChangesRef.current.get(blockId);
    if (existing) {
      clearTimeout(existing.timeoutId);
    }

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

  const saveImmediate = useCallback((blockId: number, content: string) => {
    cancel(blockId);
    saveBlock(blockId, content);
  }, [cancel, saveBlock]);

  const hasPendingChanges = useCallback((blockId?: number) => {
    if (blockId !== undefined) {
      return pendingChangesRef.current.has(blockId);
    }
    return pendingChangesRef.current.size > 0;
  }, []);

  useEffect(() => {
    const pending = pendingChangesRef.current;
    return () => {
      pending.forEach((pendingItem, blockId) => {
        clearTimeout(pendingItem.timeoutId);
        saveBlock(blockId, pendingItem.content);
      });
      pending.clear();
    };
  }, [saveBlock]);

  useEffect(() => {
    flushRegistry.add(flushAll);
    return () => { flushRegistry.delete(flushAll); };
  }, [flushAll]);

  useEffect(() => {
    const handleBeforeUnload = () => {
      flushAll();
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [flushAll]);

  return {
    handleContentChange,
    saveImmediate,
    flushBlock,
    flushAll,
    cancel,
    cancelAll,
    hasPendingChanges,
    isSaving: updateNode.isPending,
  };
}

export default useContentSave;
