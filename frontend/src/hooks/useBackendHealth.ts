/**
 * useBackendHealth — poll the backend health endpoint
 *
 * Performs an initial check on mount, then polls every 3 seconds while the
 * backend appears unhealthy. Uses native fetch to avoid spamming the axios
 * error logger on every failed poll.
 *
 * The UI degrades gracefully: a warning banner is shown after two consecutive
 * failures, and a full-screen lock is only applied after the outage persists
 * for `LOCK_THRESHOLD_MS`.
 */
import { useEffect, useRef } from 'react';
import { useConnectionStore } from '@/stores/connectionStore';
import { getLogger } from '@/utils/logger';

const log = getLogger('useBackendHealth');

const HEALTH_URL = '/api/health';
const HEALTHY_POLL_MS = 30_000; // recheck every 30s even when healthy
const UNHEALTHY_POLL_MS = 3_000; // recheck quickly while recovering
const TIMEOUT_MS = 5_000;
const LOCK_THRESHOLD_MS = 30_000; // full lock only after 30s of confirmed outage

async function checkHealth(): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(HEALTH_URL, {
      method: 'GET',
      signal: controller.signal,
      credentials: 'same-origin',
    });
    clearTimeout(timeout);
    return response.ok && response.status === 200;
  } catch (_err) {
    clearTimeout(timeout);
    return false;
  }
}

export function useBackendHealth(): void {
  const { markHealthy, markUnhealthy, markLocked } = useConnectionStore();
  const consecutiveFailuresRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      const isHealthy = await checkHealth();
      if (cancelled) return;

      const state = useConnectionStore.getState();

      if (isHealthy) {
        consecutiveFailuresRef.current = 0;
        if (state.healthy !== true) {
          log.info('Backend health check succeeded — unlocking UI');
          markHealthy();
        }
      } else {
        consecutiveFailuresRef.current += 1;
        // Require two consecutive failures before treating the backend as down.
        // A single failed check is common during startup while the backend
        // container is still initializing.
        if (consecutiveFailuresRef.current >= 2 && state.healthy !== false) {
          log.warn('Backend health check failed — showing warning banner');
          markUnhealthy('health check failed');
        }

        // Only lock the UI after the outage has persisted past the threshold.
        const since = state.unhealthySince;
        if (since && Date.now() - since >= LOCK_THRESHOLD_MS && !state.lockUI) {
          log.warn('Backend still unhealthy — locking UI');
          markLocked();
        }
      }

      // Schedule the next check based on the result we just observed.
      // Using the local result keeps the poller responsive after a state
      // transition, before the React render has updated the store.
      const nextDelay = isHealthy ? HEALTHY_POLL_MS : UNHEALTHY_POLL_MS;
      timeoutId = setTimeout(tick, nextDelay);
    };

    // Run the first check immediately.
    timeoutId = setTimeout(tick, 0);

    return () => {
      cancelled = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };
  }, [markHealthy, markUnhealthy, markLocked]);
}
