/**
 * useContentSave — Debounced content-save bridge to the core WorkspaceStore.
 *
 * This hook no longer talks to the legacy OperationRuntime. It debounces local
 * content changes and applies them to the local-first core store via
 * `store.updateText`. The sync engine observes operations and persists them.
 *
 * Re-exports:
 * - flushAllContentSaves: flushes every active instance's debounce timers.
 * - awaitAllContentSaves: best-effort await (resolves immediately in the core
 *   path because updates are synchronous once flushed).
 */

import { useCallback, useRef, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { parseAST, convertMarkdownInAST } from '@/lib/astBuilder';
import { useWorkspaceStore } from '@/core/hooks';

const flushRegistry = new Set<() => void>();

export function flushAllContentSaves(): void {
  flushRegistry.forEach((flush) => flush());
}

export async function awaitAllContentSaves(): Promise<void> {
  flushAllContentSaves();
  // Core store updates are synchronous once flushed; there is no in-flight REST
  // request to wait for in this path.
  return Promise.resolve();
}

/** Number of keystrokes between forced text-edit flushes. */
const KEYSTROKE_FLUSH_INTERVAL = 10;

/** Default debounce for text edits in the local-first path. */
const DEFAULT_TEXT_DEBOUNCE_MS = 150;

/** Pending change entry */
interface PendingChange {
  blockId: string;
  content: string;
  timeoutId: ReturnType<typeof setTimeout>;
  keystrokes: number;
}

interface UseContentSaveOptions {
  /** Debounce delay in ms (default: 150) */
  delay?: number;
}

/**
 * Hook for debounced content saving through the core WorkspaceStore.
 */
export function useContentSave(options: UseContentSaveOptions = {}) {
  const { delay = DEFAULT_TEXT_DEBOUNCE_MS } = options;
  const pendingChangesRef = useRef<Map<string, PendingChange>>(new Map());
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const { store } = useWorkspaceStore(workspaceId ?? '');

  const saveBlock = useCallback(async (blockId: string, content: string) => {
    if (!store) return;

    const ast = parseAST(content);
    const converted = convertMarkdownInAST(ast);
    const finalContent = converted !== ast ? JSON.stringify(converted) : content;

    store.updateText(blockId, (text) => {
      const current = text.toPlaintext();
      text.delete(0, current.length);
      text.insert(0, finalContent);
    });
  }, [store]);

  const flushBlock = useCallback((blockId: string) => {
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

  const cancel = useCallback((blockId: string) => {
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

  const handleContentChange = useCallback((blockId: string, content: string) => {
    const existing = pendingChangesRef.current.get(blockId);
    if (existing) {
      clearTimeout(existing.timeoutId);
    }

    const keystrokes = (existing?.keystrokes ?? 0) + 1;
    const shouldFlushNow = keystrokes >= KEYSTROKE_FLUSH_INTERVAL;

    if (shouldFlushNow) {
      pendingChangesRef.current.delete(blockId);
      saveBlock(blockId, content);
      return;
    }

    const timeoutId = setTimeout(() => {
      pendingChangesRef.current.delete(blockId);
      saveBlock(blockId, content);
    }, delay);

    pendingChangesRef.current.set(blockId, {
      blockId,
      content,
      timeoutId,
      keystrokes,
    });
  }, [delay, saveBlock]);

  const saveImmediate = useCallback((blockId: string, content: string) => {
    cancel(blockId);
    saveBlock(blockId, content);
  }, [cancel, saveBlock]);

  const hasPendingChanges = useCallback((blockId?: string) => {
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

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        flushAll();
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
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
