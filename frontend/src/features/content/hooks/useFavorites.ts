/**
 * Favorites hooks backed by the workspace operation log.
 *
 * Favorites are stored as `user.favorite.*` operations in the local-first
 * SQLite derived store, so they sync across devices and survive browser data
 * clearing as long as the workspace relay is intact.
 */
import { useEffect, useState, useCallback } from 'react';
import { useWorkspaceStoreClient } from '@/core/hooks/useWorkspaceStoreClient';
import { getWorkspaceStoreClient } from '@/core/adapters/workspaceStoreClientAdapter';

export interface UseFavoritesResult {
  data: string[];
  isLoading: boolean;
  error: Error | null;
}

/**
 * Module-level cache of the last known favorites list per workspace.
 *
 * `useFavorites` keeps this cache warm while mounted, and the synchronous
 * `isFavorite` helper reads from it. This preserves the public
 * `isFavorite(workspaceId, nodeId): boolean` signature after migrating the
 * favorites hooks to the async worker-backed store client.
 */
const favoritesCache = new Map<string, string[]>();

export function useFavorites(workspaceId: string | undefined): UseFavoritesResult {
  const { client, isLoading, error } = useWorkspaceStoreClient(workspaceId ?? '');
  const [favorites, setFavorites] = useState<string[]>([]);

  useEffect(() => {
    if (!client || !workspaceId) {
      setFavorites([]);
      return;
    }
    let cancelled = false;
    const update = async (): Promise<void> => {
      const list = await client.query<string[]>('getFavorites', []);
      if (!cancelled) {
        favoritesCache.set(workspaceId, list);
        setFavorites(list);
      }
    };
    update();
    const unsubscribe = client.subscribe(null, update);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [client, workspaceId]);

  return { data: favorites, isLoading, error };
}

export function useAddFavoriteMutation(workspaceId: string | undefined) {
  const { client } = useWorkspaceStoreClient(workspaceId ?? '');

  const mutateAsync = useCallback(
    async (nodeUuid: string): Promise<void> => {
      if (!client) throw new Error('Workspace store is not ready');
      await client.mutate<void>('addFavorite', [nodeUuid]);
    },
    [client]
  );

  const mutate = useCallback(
    (nodeUuid: string) => {
      if (!client) return;
      return mutateAsync(nodeUuid);
    },
    [client, mutateAsync]
  );

  return { mutate, mutateAsync };
}

export function useRemoveFavoriteMutation(workspaceId: string | undefined) {
  const { client } = useWorkspaceStoreClient(workspaceId ?? '');

  const mutateAsync = useCallback(
    async (nodeUuid: string): Promise<void> => {
      if (!client) throw new Error('Workspace store is not ready');
      await client.mutate<void>('removeFavorite', [nodeUuid]);
    },
    [client]
  );

  const mutate = useCallback(
    (nodeUuid: string) => {
      if (!client) return;
      return mutateAsync(nodeUuid);
    },
    [client, mutateAsync]
  );

  return { mutate, mutateAsync };
}

export function useReorderFavoritesMutation(workspaceId: string | undefined) {
  const { client } = useWorkspaceStoreClient(workspaceId ?? '');

  const mutateAsync = useCallback(
    async ({ fromIndex, toIndex }: { fromIndex: number; toIndex: number }): Promise<void> => {
      if (!client) throw new Error('Workspace store is not ready');
      const favorites = await client.query<string[]>('getFavorites', []);
      if (
        fromIndex < 0 ||
        fromIndex >= favorites.length ||
        toIndex < 0 ||
        toIndex >= favorites.length ||
        fromIndex === toIndex
      ) {
        return;
      }
      const next = [...favorites];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      await client.mutate<void>('reorderFavorites', [next]);
    },
    [client]
  );

  const mutate = useCallback(
    ({ fromIndex, toIndex }: { fromIndex: number; toIndex: number }) => {
      if (!client) return;
      return mutateAsync({ fromIndex, toIndex });
    },
    [client, mutateAsync]
  );

  return { mutate, mutateAsync };
}

export async function addFavorite(
  workspaceId: string | undefined,
  nodeUuid: string
): Promise<string[]> {
  if (!workspaceId) return [];
  const client = getWorkspaceStoreClient(workspaceId);
  if (!client) return [];
  await client.mutate<void>('addFavorite', [nodeUuid]);
  return client.query<string[]>('getFavorites', []);
}

export async function removeFavorite(
  workspaceId: string | undefined,
  nodeUuid: string
): Promise<string[]> {
  if (!workspaceId) return [];
  const client = getWorkspaceStoreClient(workspaceId);
  if (!client) return [];
  await client.mutate<void>('removeFavorite', [nodeUuid]);
  return client.query<string[]>('getFavorites', []);
}

export async function reorderFavorites(
  workspaceId: string | undefined,
  fromIndex: number,
  toIndex: number
): Promise<string[]> {
  if (!workspaceId) return [];
  const client = getWorkspaceStoreClient(workspaceId);
  if (!client) return [];
  const favorites = await client.query<string[]>('getFavorites', []);
  if (
    fromIndex < 0 ||
    fromIndex >= favorites.length ||
    toIndex < 0 ||
    toIndex >= favorites.length ||
    fromIndex === toIndex
  ) {
    return favorites;
  }
  const next = [...favorites];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  await client.mutate<void>('reorderFavorites', [next]);
  return client.query<string[]>('getFavorites', []);
}

/**
 * Synchronous favorite check.
 *
 * Reads from the module-level cache maintained by `useFavorites`. This keeps the
 * public signature unchanged after the migration to the async worker-backed
 * store client.
 */
export function isFavorite(workspaceId: string | undefined, nodeUuid: string): boolean {
  if (!workspaceId || !nodeUuid) return false;
  const cached = favoritesCache.get(workspaceId);
  return cached?.includes(nodeUuid) ?? false;
}

