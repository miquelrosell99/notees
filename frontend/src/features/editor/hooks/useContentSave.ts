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
import { useWorkspaceStoreClient } from '@/core/hooks';
import { useUndoManager } from '@/core/hooks';

const PENDING_CONTENT_BACKUP_KEY = (workspaceId: string) =>
  `notees:pendingContent:${workspaceId}`;
const BACKUP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

interface PendingContentBackup {
  timestamp: number;
  changes: Record<string, string>;
}

function isStorageAvailable(): boolean {
  return typeof localStorage !== 'undefined';
}

function readPendingBackup(workspaceId: string): Record<string, string> | null {
  if (!isStorageAvailable()) return null;
  try {
    const raw = localStorage.getItem(PENDING_CONTENT_BACKUP_KEY(workspaceId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PendingContentBackup;
    if (!parsed || typeof parsed.timestamp !== 'number' || !parsed.changes) {
      return null;
    }
    if (Date.now() - parsed.timestamp > BACKUP_MAX_AGE_MS) {
      localStorage.removeItem(PENDING_CONTENT_BACKUP_KEY(workspaceId));
      return null;
    }
    return parsed.changes;
  } catch {
    return null;
  }
}

function writePendingBackup(
  workspaceId: string,
  pending: Map<string, { content: string }>
): void {
  if (!isStorageAvailable() || pending.size === 0) return;
  try {
    const changes: Record<string, string> = {};
    for (const [blockId, change] of pending) {
      changes[blockId] = change.content;
    }
    const backup: PendingContentBackup = { timestamp: Date.now(), changes };
    localStorage.setItem(
      PENDING_CONTENT_BACKUP_KEY(workspaceId),
      JSON.stringify(backup)
    );
  } catch {
    // Best-effort backup; ignore quota/private-mode errors.
  }
}

function clearPendingBackup(workspaceId: string): void {
  if (!isStorageAvailable()) return;
  try {
    localStorage.removeItem(PENDING_CONTENT_BACKUP_KEY(workspaceId));
  } catch {
    // Best-effort cleanup.
  }
}

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
  const earlyChangesRef = useRef<Map<string, string>>(new Map());
  // Per-block save chains: recordSetNodeText is a full-text SET, so two
  // concurrent saves for the same block could land out of order and let the
  // older snapshot overwrite newer keystrokes. Chaining guarantees order.
  const saveQueuesRef = useRef<Map<string, Promise<void>>>(new Map());
  const hasRestoredRef = useRef(false);
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const { client } = useWorkspaceStoreClient(workspaceId ?? '');
  const manager = useUndoManager(workspaceId ?? '');

  const saveBlock = useCallback((blockId: string, content: string): Promise<void> => {
    if (!client || !manager) {
      // Buffer edits that arrive before the workspace client and undo manager
      // are ready; they will be flushed once both become available.
      earlyChangesRef.current.set(blockId, content);
      return Promise.resolve();
    }

    const prev = saveQueuesRef.current.get(blockId) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(async () => {
      const ast = parseAST(content);
      const converted = convertMarkdownInAST(ast);
      const finalContent = converted !== ast ? JSON.stringify(converted) : content;
      // The store no-ops when the text is unchanged, so no main-thread
      // read-back/compare is needed here.
      await manager.recordSetNodeText(blockId, finalContent);
    });
    saveQueuesRef.current.set(blockId, next);
    void next.finally(() => {
      if (saveQueuesRef.current.get(blockId) === next) {
        saveQueuesRef.current.delete(blockId);
      }
    });
    return next;
  }, [client, manager]);

  const flushEarlyChanges = useCallback(async () => {
    if (!client || !manager) return;
    const entries = Array.from(earlyChangesRef.current.entries());
    if (entries.length === 0) return;
    earlyChangesRef.current.clear();
    await Promise.all(
      entries.map(async ([blockId, content]) => {
        await saveBlock(blockId, content);
      })
    );
  }, [client, manager, saveBlock]);

  // Flush any edits that were queued while the workspace client was still
  // initializing as soon as both the client and undo manager are available.
  useEffect(() => {
    if (client && manager) {
      void flushEarlyChanges();
    }
  }, [client, manager, flushEarlyChanges]);

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
    const saves = pending.map(async ([blockId, change]) => {
      clearTimeout(change.timeoutId);
      await saveBlock(blockId, change.content);
    });
    // Also await saves that are already in flight (e.g. started by an earlier
    // blur flush) so callers that flush before refocusing never observe a
    // store that still lags behind what the user typed.
    await Promise.all([...saves, ...saveQueuesRef.current.values()]);
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
      void saveBlock(blockId, content).catch((err) => {
        console.error('[useContentSave] keystroke-interval save failed for block', blockId, err);
      });
      return;
    }

    const timeoutId = setTimeout(() => {
      pendingChangesRef.current.delete(blockId);
      void saveBlock(blockId, content).catch((err) => {
        console.error('[useContentSave] debounced save failed for block', blockId, err);
      });
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
      ).catch((err) => {
        console.error('[useContentSave] unmount flush failed', err);
      });
    };
  }, [saveBlock]);

  useEffect(() => {
    const entry: Flushable = { flushAll };
    flushRegistry.add(entry);
    return () => { flushRegistry.delete(entry); };
  }, [flushAll]);

  // Restore any content that was synchronously backed up during a previous
  // beforeunload/visibilitychange event but did not finish flushing to the worker.
  useEffect(() => {
    if (!client || !manager || !workspaceId || hasRestoredRef.current) return;
    const backup = readPendingBackup(workspaceId);
    if (!backup || Object.keys(backup).length === 0) return;

    hasRestoredRef.current = true;

    const entries = Object.entries(backup);
    void Promise.all(
      entries.map(([blockId, content]) =>
        saveBlock(blockId, content).catch((_err) => {
          console.error(
            '[useContentSave] Failed to restore pending content for block',
            blockId
          );
        })
      )
    ).then(() => {
      clearPendingBackup(workspaceId);
    });
  }, [client, manager, workspaceId, saveBlock]);

  useEffect(() => {
    const buildBackupMap = (): Map<string, { content: string }> => {
      const merged = new Map<string, { content: string }>();
      for (const [blockId, change] of pendingChangesRef.current) {
        merged.set(blockId, { content: change.content });
      }
      for (const [blockId, content] of earlyChangesRef.current) {
        merged.set(blockId, { content });
      }
      return merged;
    };

    const handleBeforeUnload = () => {
      if (workspaceId) {
        writePendingBackup(workspaceId, buildBackupMap());
      }
      void flushAll();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        if (workspaceId) {
          writePendingBackup(workspaceId, buildBackupMap());
        }
        void flushAll();
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [flushAll, workspaceId]);

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
