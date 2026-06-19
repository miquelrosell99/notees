/**
 * Connection Store — global backend reachability state
 *
 * Tracks whether the FastAPI backend is currently reachable. The UI can render
 * a lock overlay when the backend is down (e.g. Postgres recovering, container
 * restarting, proxy 502).
 */
import { create } from 'zustand';

export interface ConnectionState {
  /** `null` during the first health check, `true` when reachable, `false` when down. */
  healthy: boolean | null;
  /** Human-readable reason for the last unhealthy transition (for debugging). */
  reason: string | null;
  /** True only when we have confirmed the backend is unreachable. */
  lockUI: boolean;

  // Actions
  markHealthy: () => void;
  markUnhealthy: (reason?: string) => void;
}

export const useConnectionStore = create<ConnectionState>()((set) => ({
  healthy: null,
  reason: null,
  lockUI: false,

  markHealthy: () =>
    set(() => ({
      healthy: true,
      reason: null,
      lockUI: false,
    })),

  markUnhealthy: (reason) =>
    set(() => ({
      healthy: false,
      reason: reason ?? null,
      lockUI: true,
    })),
}));
