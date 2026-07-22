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

export interface SyncPullProgress {
  applied: number;
  total: number;
}

export interface WorkspaceSyncProgress {
  isInitializing: boolean;
  pullProgress: SyncPullProgress | null;
}

export interface SyncStatusState {
  status: SyncStatus;
  pendingCount: number;
  failedCount: number;
  lastError: string | null;
  /** Per-workspace initialization state so switching workspaces doesn't fight. */
  workspaceProgress: Record<string, WorkspaceSyncProgress>;
  /** Workspace currently undergoing an explicit force re-sync; locks the UI. */
  forceResyncWorkspaceId: string | null;
  /** Bumped when the user explicitly discards local state and checks out from the server. */
  workspaceResetNonce: number;
  setStatus: (
    status: SyncStatus,
    opts?: {
      pendingCount?: number;
      failedCount?: number;
      lastError?: string | null;
    },
  ) => void;
  setWorkspaceInitializing: (workspaceId: string, isInitializing: boolean) => void;
  setWorkspacePullProgress: (workspaceId: string, pullProgress: SyncPullProgress | null) => void;
  getWorkspaceProgress: (workspaceId: string) => WorkspaceSyncProgress;
  setForceResyncWorkspaceId: (workspaceId: string | null) => void;
  bumpWorkspaceResetNonce: () => void;
}

export const DEFAULT_PROGRESS: WorkspaceSyncProgress = {
  isInitializing: false,
  pullProgress: null,
};

export const useSyncStatusStore = create<SyncStatusState>((set, get) => ({
  status: 'synced',
  pendingCount: 0,
  failedCount: 0,
  lastError: null,
  workspaceProgress: {},
  forceResyncWorkspaceId: null,
  workspaceResetNonce: 0,
  setStatus: (status, opts) =>
    set((state) => ({
      status,
      pendingCount: opts?.pendingCount ?? state.pendingCount,
      failedCount: opts?.failedCount ?? state.failedCount,
      lastError: opts?.lastError !== undefined ? opts.lastError : state.lastError,
    })),
  setWorkspaceInitializing: (workspaceId, isInitializing) =>
    set((state) => ({
      workspaceProgress: {
        ...state.workspaceProgress,
        [workspaceId]: {
          ...(state.workspaceProgress[workspaceId] ?? DEFAULT_PROGRESS),
          isInitializing,
        },
      },
    })),
  setWorkspacePullProgress: (workspaceId, pullProgress) =>
    set((state) => ({
      workspaceProgress: {
        ...state.workspaceProgress,
        [workspaceId]: {
          ...(state.workspaceProgress[workspaceId] ?? DEFAULT_PROGRESS),
          pullProgress,
        },
      },
    })),
  getWorkspaceProgress: (workspaceId) =>
    get().workspaceProgress[workspaceId] ?? DEFAULT_PROGRESS,
  setForceResyncWorkspaceId: (workspaceId) =>
    set({ forceResyncWorkspaceId: workspaceId }),
  bumpWorkspaceResetNonce: () =>
    set((state) => ({ workspaceResetNonce: state.workspaceResetNonce + 1 })),
}));
