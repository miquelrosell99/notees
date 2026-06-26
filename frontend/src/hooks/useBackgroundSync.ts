/**
 * useBackgroundSync
 *
 * Registers web background sync mechanisms:
 * - Periodic Background Sync (15 min interval) when supported and permitted.
 * - One-shot Background Sync when the browser goes back online.
 *
 * The service worker (`/sw-sync.js`) forwards the event to app clients via
 * `postMessage`; listeners here dispatch a `notees:background-sync` event that
 * the sync layer can subscribe to.
 */
import { useEffect } from 'react';
import { getLogger } from '@/utils/logger';

const log = getLogger('background-sync');
const SYNC_TAG = 'notees-sync';
const MIN_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

export function useBackgroundSync() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;

    let messageHandler: ((event: MessageEvent) => void) | null = null;
    let cancelled = false;

    async function register() {
      try {
        const registration = await navigator.serviceWorker.ready;
        if (cancelled) return;

        // Periodic Background Sync — requires a user-visible install/PWA context.
        if ('periodicSync' in registration) {
          try {
            const permission = await (navigator as NavigatorWithPermissions).permissions.query({
              name: 'periodic-background-sync' as PermissionName,
            });
            if (permission.state === 'granted' || permission.state === 'prompt') {
              await (registration as ServiceWorkerRegistrationWithPeriodicSync).periodicSync.register(
                SYNC_TAG,
                { minInterval: MIN_INTERVAL_MS }
              );
              log.info('Periodic background sync registered');
            }
          } catch (err) {
            log.debug('Periodic background sync not available', err);
          }
        }

        // One-shot background sync for when connectivity returns.
        if ('sync' in registration) {
          try {
            await (registration as ServiceWorkerRegistrationWithSync).sync.register(SYNC_TAG);
            log.info('One-shot background sync registered');
          } catch (err) {
            log.debug('Background sync not available', err);
          }
        }
      } catch (err) {
        log.warn('Failed to register background sync', err);
      }
    }

    messageHandler = (event: MessageEvent) => {
      if (event.data?.type === 'BACKGROUND_SYNC') {
        log.info('Background sync event received from service worker');
        window.dispatchEvent(new CustomEvent('notees:background-sync'));
      }
    };
    navigator.serviceWorker.addEventListener('message', messageHandler);

    register();

    return () => {
      cancelled = true;
      if (messageHandler) {
        navigator.serviceWorker.removeEventListener('message', messageHandler);
      }
    };
  }, []);
}

interface NavigatorWithPermissions extends Navigator {
  permissions: Permissions & {
    query(options: { name: 'periodic-background-sync' }): Promise<PermissionStatus>;
  };
}

interface ServiceWorkerRegistrationWithPeriodicSync extends ServiceWorkerRegistration {
  periodicSync: {
    register(tag: string, options?: { minInterval?: number }): Promise<void>;
    unregister(tag: string): Promise<void>;
  };
}

interface ServiceWorkerRegistrationWithSync extends ServiceWorkerRegistration {
  sync: {
    register(tag: string): Promise<void>;
  };
}
