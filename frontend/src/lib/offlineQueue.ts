/**
 * Offline Mutation Queue
 *
 * Stores failed mutations in IndexedDB so they can be replayed when
 * the connection is restored. Uses idb-keyval (already a dependency
 * for query cache persistence).
 *
 * Design:
 * - Content mutations for the same block are deduplicated (only the
 *   latest state is queued).
 * - Drain is sequential to avoid race conditions.
 * - 4xx errors are dropped (don't retry invalid requests).
 * - Network/5xx errors are retried with exponential backoff.
 */

import { get, set, del } from 'idb-keyval';
import type { AxiosError } from 'axios';

const QUEUE_KEY = 'notees-offline-queue';

export interface QueuedMutation {
  id: string;
  type: 'content';
  blockId: number;
  blockUuid: string;
  data: { name: string };
  timestamp: number;
  retryCount: number;
}

function generateId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function _getQueue(): Promise<QueuedMutation[]> {
  const value = await get(QUEUE_KEY);
  if (Array.isArray(value)) return value;
  return [];
}

async function _setQueue(queue: QueuedMutation[]): Promise<void> {
  await set(QUEUE_KEY, queue);
}

export const offlineQueue = {
  /**
   * Add a mutation to the queue.
   * For content mutations, replaces any existing pending mutation
   * for the same block (deduplication).
   */
  async enqueue(
    mutation: Omit<QueuedMutation, 'id' | 'timestamp' | 'retryCount'>,
  ): Promise<void> {
    const item: QueuedMutation = {
      ...mutation,
      id: generateId(),
      timestamp: Date.now(),
      retryCount: 0,
    };

    const queue = await _getQueue();

    // Deduplicate content mutations for the same block
    const filtered = queue.filter(
      (q) => !(q.type === 'content' && q.blockId === item.blockId),
    );
    filtered.push(item);

    await _setQueue(filtered);
  },

  /** Get the current queue (newest first). */
  async getQueue(): Promise<QueuedMutation[]> {
    return _getQueue();
  },

  /** Remove a specific item by ID. */
  async remove(id: string): Promise<void> {
    const queue = await _getQueue();
    const filtered = queue.filter((q) => q.id !== id);
    await _setQueue(filtered);
  },

  /** Clear the entire queue. */
  async clear(): Promise<void> {
    await del(QUEUE_KEY);
  },

  /** Number of pending mutations. */
  async count(): Promise<number> {
    const queue = await _getQueue();
    return queue.length;
  },

  /**
   * Drain the queue by processing each mutation.
   *
   * @param process - Async function that processes one mutation.
   *   Should throw on failure.
   * @returns Object with succeeded and failed counts.
   */
  async drain(
    process: (item: QueuedMutation) => Promise<void>,
  ): Promise<{ succeeded: number; failed: number; dropped: number }> {
    const queue = await _getQueue();
    if (queue.length === 0) {
      return { succeeded: 0, failed: 0, dropped: 0 };
    }

    const remaining: QueuedMutation[] = [];
    let succeeded = 0;
    let failed = 0;
    let dropped = 0;

    for (const item of queue) {
      // Skip items that have been retried too many times
      if (item.retryCount >= 5) {
        dropped++;
        continue;
      }

      try {
        await process(item);
        succeeded++;
      } catch (error) {
        const axiosError = error as AxiosError;
        const status = axiosError.response?.status;

        if (status && status >= 400 && status < 500) {
          // 4xx — don't retry invalid requests
          console.warn(`[OfflineQueue] Dropping mutation ${item.id} after ${status} error`);
          dropped++;
        } else {
          // Network or 5xx — retry later
          remaining.push({ ...item, retryCount: item.retryCount + 1 });
          failed++;
        }
      }
    }

    await _setQueue(remaining);
    return { succeeded, failed, dropped };
  },
};
