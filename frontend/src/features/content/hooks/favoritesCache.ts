/**
 * Synchronous read-only mirror of the worker-owned favorites list.
 *
 * The cache is primed when a workspace client is opened and kept up to date by
 * a global subscription, so `isFavorite` can be synchronous and reliable even
 * when `useFavorites` is not mounted.
 */

import type { IWorkspaceStoreClient } from '@/core/worker/workerProtocol';

const favoritesCache = new Map<string, string[]>();

export function setFavorites(workspaceId: string, favorites: string[]): void {
  favoritesCache.set(workspaceId, favorites);
}

export function getCachedFavorites(workspaceId: string): string[] | undefined {
  return favoritesCache.get(workspaceId);
}

export function clearFavoritesCache(workspaceId: string): void {
  favoritesCache.delete(workspaceId);
}

/**
 * Synchronous favorite check.
 *
 * Reads from the module-level cache maintained by the workspace client
 * subscription. This keeps the public `isFavorite` signature unchanged after
 * the migration to the async worker-backed store client.
 */
export function isFavorite(
  workspaceId: string | undefined,
  nodeUuid: string
): boolean {
  if (!workspaceId || !nodeUuid) return false;
  return favoritesCache.get(workspaceId)?.includes(nodeUuid) ?? false;
}

/**
 * Query the worker for the current favorites list and populate the cache.
 *
 * Errors are logged but not thrown so that workspace open cannot be blocked by
 * a favorites query failure.
 */
export async function warmFavoritesCache(
  workspaceId: string,
  client: IWorkspaceStoreClient
): Promise<void> {
  try {
    const list = await client.query<string[]>('getFavorites', []);
    setFavorites(workspaceId, list);
  } catch (err) {
    console.error(
      `Failed to warm favorites cache for workspace ${workspaceId}:`,
      err
    );
  }
}

/**
 * Subscribe to workspace changes and keep the favorites cache up to date for
 * the lifetime of the client.
 *
 * The returned unsubscribe function should be called when the workspace client
 * is closed or reset.
 */
export function subscribeFavorites(
  workspaceId: string,
  client: IWorkspaceStoreClient,
  onUpdate?: (favorites: string[]) => void
): () => void {
  const update = async (): Promise<void> => {
    try {
      const list = await client.query<string[]>('getFavorites', []);
      setFavorites(workspaceId, list);
      onUpdate?.(list);
    } catch (err) {
      console.error(
        `Failed to update favorites cache for workspace ${workspaceId}:`,
        err
      );
    }
  };

  // Prime the cache immediately in case this subscription is set up after the
  // workspace has already been opened.
  void update();

  return client.subscribe(null, update);
}
