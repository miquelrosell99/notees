/**
 * Background sync companion for the Notees service worker.
 *
 * Imported by the generated Workbox service worker via `importScripts`.
 * Handles:
 * - `periodicsync` events for periodic background sync (PWA install required).
 * - `sync` events for one-shot background sync when connectivity returns.
 *
 * When the app is open, events are forwarded to clients so the sync layer can
 * run in the foreground context. When the app is closed, a lightweight ping
 * keeps the service worker alive; full sync runs the next time the app opens.
 */
const SYNC_TAG = 'notees-sync';

self.addEventListener('periodicsync', (event) => {
  if (event.tag === SYNC_TAG) {
    event.waitUntil(handleBackgroundSync());
  }
});

self.addEventListener('sync', (event) => {
  if (event.tag === SYNC_TAG) {
    event.waitUntil(handleBackgroundSync());
  }
});

async function handleBackgroundSync() {
  const clients = await self.clients.matchAll({
    type: 'window',
    includeUncontrolled: false,
  });

  if (clients.length > 0) {
    // The app is running — let the foreground sync layer do the work.
    clients.forEach((client) => {
      client.postMessage({ type: 'BACKGROUND_SYNC' });
    });
    // Also register a one-shot sync tag so the PWA runtime can wake the app
    // if it is backgrounded when connectivity returns.
    if ('sync' in self.registration) {
      try {
        await self.registration.sync.register('notees-sqlite-sync');
      } catch {
        // SW sync registration may fail in unsupported browsers — safe to ignore.
      }
    }
  } else {
    // App is closed. Ping the server to keep the service worker alive.
    // A full sync requires client-side state and runs when the app reopens.
    try {
      await fetch('/api/auth/status', {
        method: 'GET',
        credentials: 'include',
        cache: 'no-store',
      });
    } catch {
      // Network offline or server unreachable — safe to ignore.
    }
  }
}
