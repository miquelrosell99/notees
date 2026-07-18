import type { SyncEngine } from '../sync';

/**
 * Register browser event listeners that trigger a sync when the app becomes
 * visible or the device comes back online.
 *
 * Returns a cleanup function that removes the listeners.
 */
export function registerVisibilitySync(syncEngine: SyncEngine): () => void {
  const handleVisibilityChange = (): void => {
    if (document.visibilityState === 'visible') {
      void syncEngine.sync();
    }
  };

  const handleOnline = (): void => {
    void syncEngine.sync();
  };

  document.addEventListener('visibilitychange', handleVisibilityChange);
  window.addEventListener('online', handleOnline);

  return () => {
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    window.removeEventListener('online', handleOnline);
  };
}
