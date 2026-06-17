/**
 * useContentSave — Debounced content-save bridge to OperationRuntime.
 *
 * This hook no longer talks to the API directly. It simply debounces local
 * content changes and forwards them to the runtime as `update_content` intents.
 * The runtime projection updates immediately; SyncManager observes pending
 * operations and persists them through TanStack Query.
 *
 * Re-exports:
 * - flushAllContentSaves: flushes every active instance's debounce timers.
 * - awaitAllContentSaves: waits until the runtime has no pending/in-flight
 *   content operations (best-effort timeout).
 */

import { useCallback, useRef, useEffect } from 'react';
import { parseAST, convertMarkdownInAST } from '@/lib/astBuilder';
import { getOperationRuntime } from '@/runtime';
import { getNode, getNodeByServerId } from '@/runtime/graphHelpers';
import type { MutationIntent } from '@/runtime/types';
import { getUndoEngine } from '@/stores/undoEngine';
import { liveSyncManager } from '@/collab/LiveSyncManager';
import { flushRegistry } from '@/hooks/contentSaveTracker';

export { flushAllContentSaves, awaitAllContentSaves } from '@/hooks/contentSaveTracker';

/** Pending change entry */
interface PendingChange {
  blockId: number | string;
  content: string;
  timeoutId: ReturnType<typeof setTimeout>;
}

interface UseContentSaveOptions {
  /** Debounce delay in ms (default: 500) */
  delay?: number;
}

/**
 * Hook for debounced content saving through the runtime.
 */
export function useContentSave(options: UseContentSaveOptions = {}) {
  const { delay = 500 } = options;
  const pendingChangesRef = useRef<Map<number | string, PendingChange>>(new Map());

  const resolveGraphNode = useCallback((blockId: number | string) => {
    const runtime = getOperationRuntime();
    if (typeof blockId === 'number') {
      return getNodeByServerId(runtime, blockId);
    }
    return getNode(runtime, blockId);
  }, []);

  const saveBlock = useCallback((blockId: number | string, content: string) => {
    const ast = parseAST(content);
    const converted = convertMarkdownInAST(ast);

    const graphNode = resolveGraphNode(blockId);
    if (!graphNode) return;

    const finalContent = converted !== ast ? JSON.stringify(converted) : content;

    if (typeof navigator !== 'undefined' && navigator.onLine) {
      try {
        liveSyncManager.sendBlockUpdate(graphNode.blockId, graphNode.serverId ?? 0, finalContent);
      } catch {
        // Ignore broadcast errors — REST save is the source of truth.
      }
    }

    const intent: MutationIntent = {
      type: 'update_content',
      blockId: graphNode.blockId,
      contentAST: converted,
    };
    getUndoEngine().applyIntent(intent, { sourceEditorId: intent.sourceEditorId });
  }, [resolveGraphNode]);

  const flushBlock = useCallback((blockId: number | string) => {
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

  const cancel = useCallback((blockId: number | string) => {
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

  const handleContentChange = useCallback((blockId: number | string, content: string) => {
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

  const saveImmediate = useCallback((blockId: number | string, content: string) => {
    cancel(blockId);
    saveBlock(blockId, content);
  }, [cancel, saveBlock]);

  const hasPendingChanges = useCallback((blockId?: number | string) => {
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
  };
}

export default useContentSave;
