import type { SyncEngine } from '../sync';

const DEBOUNCE_MS = 300;

/**
 * Register browser event listeners that trigger a sync when the app becomes
 * visible or the device comes back online.
 *
 * The handler is debounced and skipped when a sync is already running so rapid
 * tab switching does not queue overlapping syncs.
 *
 * Returns a cleanup function that removes the listeners and any pending timer.
 */
export function registerVisibilitySync(syncEngine: SyncEngine): () => void {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const requestSync = (): void => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (syncEngine.getStatus() === 'syncing') {
        return;
      }
      void syncEngine.sync();
    }, DEBOUNCE_MS);
  };

  const handleVisibilityChange = (): void => {
    if (document.visibilityState === 'visible') {
      requestSync();
    }
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
