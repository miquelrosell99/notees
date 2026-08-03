import type { SyncEngine } from '../sync';
import { getLogger } from '@/utils/logger';

const log = getLogger('syncOnVisibility');
const DEBOUNCE_MS = 300;
/** Ignore visibility changes where the tab was hidden for less than this. */
const MIN_HIDDEN_MS = 5000;
/** Minimum time between visibility/online-triggered syncs. */
const MIN_SYNC_INTERVAL_MS = 30_000;

/**
 * Register browser event listeners that trigger a sync when the app becomes
 * visible or the device comes back online.
 *
 * The handler is debounced and skipped when a sync is already running so rapid
 * tab switching does not queue overlapping syncs. Very short hidden periods
 * (e.g. the browser suspending/resuming the tab) and rapid repeats are also
 * ignored, because each sync can flush a large workspace database to IndexedDB.
 *
 * Returns a cleanup function that removes the listeners and any pending timer.
 */
export function registerVisibilitySync(syncEngine: SyncEngine): () => void {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let hiddenAt: number | null = null;
  let lastSyncAt = 0;

  const requestSync = (reason: string): void => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (syncEngine.getStatus() === 'syncing') {
        log.debug('Skipping visibility/online sync: already syncing', { reason });
        return;
      }
      const msSinceLastSync = Date.now() - lastSyncAt;
      if (msSinceLastSync < MIN_SYNC_INTERVAL_MS) {
        log.debug('Skipping visibility/online sync: too soon', { reason, msSinceLastSync });
        return;
      }
      lastSyncAt = Date.now();
      log.info('Triggering sync from visibility/online event', { reason });
      void syncEngine.sync();
    }, DEBOUNCE_MS);
  };

  const handleVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now();
      return;
    }
    // Tab became visible again.
    if (hiddenAt === null) {
      // Ignore spurious visibilitychange events that fire without the tab having
      // been hidden (e.g. some browsers emit them on focus). Only sync after an
      // actual hidden -> visible transition.
      log.debug('Ignoring visibilitychange: tab was not hidden');
      return;
    }
    const hiddenMs = Date.now() - hiddenAt;
    hiddenAt = null;
    if (hiddenMs < MIN_HIDDEN_MS) {
      log.debug('Ignoring brief visibility change', { hiddenMs });
      return;
    }
    requestSync('visibilitychange');
  };

  const handleOnline = (): void => {
    requestSync('online');
  };

  document.addEventListener('visibilitychange', handleVisibilityChange);
  window.addEventListener('online', handleOnline);

  return () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    window.removeEventListener('online', handleOnline);
  };
}
