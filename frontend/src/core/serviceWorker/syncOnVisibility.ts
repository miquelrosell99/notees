import type { SyncEngine } from '../sync';

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

  const requestSync = (): void => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (syncEngine.getStatus() === 'syncing') {
        return;
      }
      if (Date.now() - lastSyncAt < MIN_SYNC_INTERVAL_MS) {
        return;
      }
      lastSyncAt = Date.now();
      void syncEngine.sync();
    }, DEBOUNCE_MS);
  };

  const handleVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now();
      return;
    }
    // Tab became visible again.
    if (hiddenAt !== null && Date.now() - hiddenAt < MIN_HIDDEN_MS) {
      hiddenAt = null;
      return;
    }
    hiddenAt = null;
    requestSync();
  };

  const handleOnline = (): void => {
    requestSync();
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
