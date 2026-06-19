/**
 * useBackendHealth — poll the backend health endpoint
 *
 * Performs an initial check on mount, then polls every 3 seconds while the
 * backend appears unhealthy. Uses native fetch to avoid spamming the axios
 * error logger on every failed poll.
 */
import { useEffect, useRef } from 'react';
import { useConnectionStore } from '@/stores/connectionStore';
import { getLogger } from '@/utils/logger';

const log = getLogger('useBackendHealth');

const HEALTH_URL = '/api/health';
const HEALTHY_POLL_MS = 30_000; // recheck every 30s even when healthy
const UNHEALTHY_POLL_MS = 3_000; // recheck quickly while recovering
const TIMEOUT_MS = 5_000;

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
  const { markHealthy, markUnhealthy, healthy } = useConnectionStore();
  const healthyRef = useRef(healthy);

  // Keep a ref in sync so the interval callback sees the latest value
  // without resetting the interval on every state change.
  healthyRef.current = healthy;

  useEffect(() => {
    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      const isHealthy = await checkHealth();
      if (cancelled) return;

      if (isHealthy) {
        if (healthyRef.current !== true) {
          log.info('Backend health check succeeded — unlocking UI');
          markHealthy();
        }
      } else {
        if (healthyRef.current !== false) {
          log.warn('Backend health check failed — locking UI');
          markUnhealthy('health check failed');
        }
      }

      // Schedule the next check based on the latest state.
      const nextDelay = healthyRef.current === false ? UNHEALTHY_POLL_MS : HEALTHY_POLL_MS;
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
  }, [markHealthy, markUnhealthy]);
}
