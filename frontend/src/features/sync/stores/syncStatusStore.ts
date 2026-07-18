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

export type SyncStatus = 'synced' | 'syncing' | 'offline' | 'error';

export interface SyncStatusState {
  status: SyncStatus;
  pendingCount: number;
  failedCount: number;
  lastError: string | null;
  setStatus: (
    status: SyncStatus,
    opts?: {
      pendingCount?: number;
      failedCount?: number;
      lastError?: string | null;
    },
  ) => void;
}

export const useSyncStatusStore = create<SyncStatusState>((set) => ({
  status: 'synced',
  pendingCount: 0,
  failedCount: 0,
  lastError: null,
  setStatus: (status, opts) =>
    set((state) => ({
      status,
      pendingCount: opts?.pendingCount ?? state.pendingCount,
      failedCount: opts?.failedCount ?? state.failedCount,
      lastError: opts?.lastError !== undefined ? opts.lastError : state.lastError,
    })),
}));
