/**
 * Connection Store — global backend reachability state
 *
 * Tracks whether the FastAPI backend is currently reachable. The UI degrades
 * gracefully: a dismissible warning banner appears first, and a full-screen lock
 * is only shown after the outage persists for a threshold or the user dismisses
 * the banner.
 */
import { create } from 'zustand';

export interface ConnectionState {
  /** `null` during the first health check, `true` when reachable, `false` when down. */
  healthy: boolean | null;
  /** Human-readable reason for the last unhealthy transition (for debugging). */
  reason: string | null;
  /** True only when the backend has been unhealthy long enough to lock the UI. */
  lockUI: boolean;
  /** True when the user has dismissed the warning banner for the current outage. */
  bannerDismissed: boolean;
  /** Timestamp (ms) when the backend was first observed unhealthy this outage. */
  unhealthySince: number | null;

  // Actions
  markHealthy: () => void;
  markUnhealthy: (reason?: string) => void;
  markLocked: () => void;
  markBannerDismissed: () => void;
}

export const useConnectionStore = create<ConnectionState>()((set) => ({
  healthy: null,
  reason: null,
  lockUI: false,
  bannerDismissed: false,
  unhealthySince: null,

  markHealthy: () =>
    set(() => ({
      healthy: true,
      reason: null,
      lockUI: false,
      bannerDismissed: false,
      unhealthySince: null,
    })),

  markUnhealthy: (reason) =>
    set((state) => ({
      healthy: false,
      reason: reason ?? null,
      lockUI: false,
      bannerDismissed: false,
      unhealthySince: state.unhealthySince ?? Date.now(),
    })),

  markLocked: () =>
    set(() => ({
      lockUI: true,
    })),

  markBannerDismissed: () =>
    set(() => ({
      bannerDismissed: true,
    })),
}));
