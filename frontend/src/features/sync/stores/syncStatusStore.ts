/**
 * syncStatusStore — global sync status for the v2 local-first sync protocol.
 *
 * Status values:
 * - synced:   no pending or failed operations
 * - syncing:  operations are being dispatched
 * - offline:  device is offline or backend is unhealthy; dispatch paused
 * - error:    one or more operations failed after retries
 */

import { create } from 'zustand';
import type { OutboxEntry } from '@/lib/operationStorage';

export type SyncStatus = 'synced' | 'syncing' | 'offline' | 'error';

export interface SyncStatusState {
  status: SyncStatus;
  pendingCount: number;
  failedCount: number;
  lastError: string | null;
  queue: OutboxEntry[];
  setStatus: (status: SyncStatus) => void;
  setQueue: (queue: OutboxEntry[]) => void;
}

function deriveStatus(queue: OutboxEntry[]): SyncStatus {
  if (queue.some((e) => e.attemptCount > 0 && e.nextRetryAt === null)) {
    return 'error';
  }
  if (queue.some((e) => e.nextRetryAt !== null && e.nextRetryAt > Date.now())) {
    // Waiting for retry while offline or backing off still shows as error if
    // there are failed entries; otherwise we let the caller decide (offline).
    return 'error';
  }
  if (queue.length > 0) {
    return 'syncing';
  }
  return 'synced';
}

export const useSyncStatusStore = create<SyncStatusState>((set) => ({
  status: 'synced',
  pendingCount: 0,
  failedCount: 0,
  lastError: null,
  queue: [],
  setStatus: (status) => set({ status }),
  setQueue: (queue) =>
    set({
      queue,
      pendingCount: queue.filter((e) => e.attemptCount === 0).length,
      failedCount: queue.filter((e) => e.attemptCount > 0).length,
      lastError:
        queue.find((e) => e.attemptCount > 0 && e.lastError)?.lastError ?? null,
      status: deriveStatus(queue),
    }),
}));
