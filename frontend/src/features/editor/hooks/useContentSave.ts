/**
 * useContentSave — Debounced content-save bridge to the core WorkspaceStore.
 *
 * This hook no longer talks to the legacy OperationRuntime. It debounces local
 * content changes and applies them to the local-first core store via
 * `recordSetNodeText`. The sync engine observes operations and persists them.
 *
 * Re-exports:
 * - flushAllContentSaves: flushes every active instance's debounce timers.
 * - awaitAllContentSaves: best-effort await.
 */

import { useCallback, useRef, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { parseAST, convertMarkdownInAST } from '@/lib/astBuilder';
import { TextCrdt } from '@/core/crdt/text';
import { useWorkspaceStoreClient } from '@/core/hooks';
import { useUndoManager } from '@/core/hooks';

interface Flushable {
  flushAll: () => Promise<void>;
}

const flushRegistry = new Set<Flushable>();

export async function flushAllContentSaves(): Promise<void> {
  await Promise.all(Array.from(flushRegistry).map((entry) => entry.flushAll()));
}

export async function awaitAllContentSaves(): Promise<void> {
  await flushAllContentSaves();
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
  const { client } = useWorkspaceStoreClient(workspaceId ?? '');
  const manager = useUndoManager(workspaceId ?? '');

  const saveBlock = useCallback(async (blockId: string, content: string) => {
    if (!client || !manager) return;

    const ast = parseAST(content);
    const converted = convertMarkdownInAST(ast);
    const finalContent = converted !== ast ? JSON.stringify(converted) : content;

    const currentState = await client.query<Uint8Array>('getTextState', [blockId]);
    const text = new TextCrdt(currentState);
    const current = text.toPlaintext();
    if (current === finalContent) return;

    await manager.recordSetNodeText(blockId, finalContent);
  }, [client, manager]);

  const flushBlock = useCallback(async (blockId: string) => {
    const pending = pendingChangesRef.current.get(blockId);
    if (pending) {
      clearTimeout(pending.timeoutId);
      pendingChangesRef.current.delete(blockId);
      await saveBlock(blockId, pending.content);
    }
  }, [saveBlock]);

  const flushAll = useCallback(async () => {
    const pending = Array.from(pendingChangesRef.current.entries());
    pendingChangesRef.current.clear();
    await Promise.all(
      pending.map(async ([blockId, change]) => {
        clearTimeout(change.timeoutId);
        await saveBlock(blockId, change.content);
      })
    );
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
      // Fire-and-forget; errors are logged by the worker/client.
      void saveBlock(blockId, content);
      return;
    }

    const timeoutId = setTimeout(() => {
      pendingChangesRef.current.delete(blockId);
      void saveBlock(blockId, content);
    }, delay);

    pendingChangesRef.current.set(blockId, {
      blockId,
      content,
      timeoutId,
      keystrokes,
    });
  }, [delay, saveBlock]);

  const saveImmediate = useCallback(async (blockId: string, content: string) => {
    cancel(blockId);
    await saveBlock(blockId, content);
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
      if (pending.size === 0) return;
      const snapshot = Array.from(pending.entries());
      pending.clear();
      void Promise.all(
        snapshot.map(async ([blockId, change]) => {
          clearTimeout(change.timeoutId);
          await saveBlock(blockId, change.content);
        })
      );
    };
  }, [saveBlock]);

  useEffect(() => {
    const entry: Flushable = { flushAll };
    flushRegistry.add(entry);
    return () => { flushRegistry.delete(entry); };
  }, [flushAll]);

  useEffect(() => {
    const handleBeforeUnload = () => {
      void flushAll();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        void flushAll();
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
