/**
 * useCollapsePersist — Persists manual collapse/expand changes to the backend.
 *
 * Listens for `collapse_changed` runtime events (emitted when a user manually
 * toggles collapse via bullet arrow, keyboard shortcut, or thread lines) and
 * persists the new collapsed state to the database.
 *
 * Debounces and batches changes (e.g. thread-line "collapse all children")
 * into a single API call per node.
 *
 * Uses a singleton pattern — only one active instance processes events.
 */
import { useEffect, useRef } from 'react';
import { updateNode as updateNodeApi } from '@/api/nodes';
import { getRuntimeEventBus } from '@/runtime/eventBus';

// ─── Singleton state ──────────────────────────────────────────────

let activeInstanceId: string | null = null;

/** Pending collapse changes: serverId → collapsed state */
const pendingChanges = new Map<number, boolean>();
let debounceTimeout: ReturnType<typeof setTimeout> | null = null;

const DEBOUNCE_MS = 300;

function flushChanges(): void {
  const changes = new Map(pendingChanges);
  pendingChanges.clear();

  for (const [serverId, collapsed] of changes) {
    updateNodeApi(serverId, { collapsed }).catch((error) => {
      console.error('[useCollapsePersist] Failed to persist collapse state:', error);
    });
  }
}

function scheduleFlush(): void {
  if (debounceTimeout !== null) {
    clearTimeout(debounceTimeout);
  }
  debounceTimeout = setTimeout(() => {
    debounceTimeout = null;
    flushChanges();
  }, DEBOUNCE_MS);
}

// ─── Hook ─────────────────────────────────────────────────────────

interface UseCollapsePersistOptions {
  /** When false, the hook is a no-op. Used by draft-mode editors. */
  enabled?: boolean;
}

export function useCollapsePersist(options: UseCollapsePersistOptions = {}): void {
  const { enabled = true } = options;
  const instanceIdRef = useRef<string>(Math.random().toString(36));

  useEffect(() => {
    if (!enabled) return;

    const instanceId = instanceIdRef.current;

    if (activeInstanceId === null) {
      activeInstanceId = instanceId;
    }
    if (activeInstanceId !== instanceId) return;

    const unsubscribe = getRuntimeEventBus().subscribe((event) => {
      if (event.type !== 'collapse_changed') return;
      if (event.serverId == null) return; // Not persisted yet, skip

      pendingChanges.set(event.serverId, event.collapsed);
      scheduleFlush();
    });

    return () => {
      unsubscribe();
      if (activeInstanceId === instanceId) {
        activeInstanceId = null;
      }
      // Flush any remaining changes on unmount
      if (debounceTimeout !== null) {
        clearTimeout(debounceTimeout);
        debounceTimeout = null;
        flushChanges();
      }
    };
  }, [enabled]);
}
