/**
 * useOfflineQueue — React hook for managing the offline mutation queue.
 *
 * Responsibilities:
 * - Track pending mutation count
 * - Auto-drain queue when connection is restored
 * - Expose drain progress and errors
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { offlineQueue } from '@/lib/offlineQueue';
import { useOnlineStatus } from './useOnlineStatus';
import { useUpdateNode } from './useNodeMutations';

interface UseOfflineQueueResult {
  /** Number of mutations waiting in the queue. */
  pendingCount: number;
  /** Whether the queue is currently draining. */
  isDraining: boolean;
  /** Manually trigger a drain (returns counts). */
  drain: () => Promise<{ succeeded: number; failed: number; dropped: number }>;
  /** The last drain result, if any. */
  lastResult: { succeeded: number; failed: number; dropped: number } | null;
}

export function useOfflineQueue(): UseOfflineQueueResult {
  const isOnline = useOnlineStatus();
  const updateNode = useUpdateNode();
  const [pendingCount, setPendingCount] = useState(0);
  const [isDraining, setIsDraining] = useState(false);
  const [lastResult, setLastResult] = useState<{
    succeeded: number;
    failed: number;
    dropped: number;
  } | null>(null);

  // Keep a ref to avoid stale closure in the drain callback
  const mutateRef = useRef(updateNode.mutateAsync);
  mutateRef.current = updateNode.mutateAsync;

  // Poll pending count
  const refreshCount = useCallback(async () => {
    const count = await offlineQueue.count();
    setPendingCount(count);
  }, []);

  useEffect(() => {
    refreshCount();
    const interval = setInterval(refreshCount, 2000);
    return () => clearInterval(interval);
  }, [refreshCount]);

  const drain = useCallback(async () => {
    setIsDraining(true);
    try {
      const result = await offlineQueue.drain(async (item) => {
        if (item.type === 'content') {
          await mutateRef.current({ id: item.blockId, data: item.data });
        }
      });
      setLastResult(result);
      await refreshCount();
      return result;
    } finally {
      setIsDraining(false);
    }
  }, [refreshCount]);

  // Auto-drain when coming back online
  const hasDrainedRef = useRef(false);
  useEffect(() => {
    if (isOnline && pendingCount > 0 && !isDraining) {
      if (!hasDrainedRef.current) {
        hasDrainedRef.current = true;
        drain().catch(console.error);
      }
    } else if (!isOnline) {
      hasDrainedRef.current = false;
    }
  }, [isOnline, pendingCount, isDraining, drain]);

  return {
    pendingCount,
    isDraining,
    drain,
    lastResult,
  };
}
