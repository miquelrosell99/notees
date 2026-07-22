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

export function useFavorites(workspaceId: string | undefined): UseFavoritesResult {
  const { client, isLoading, error } = useWorkspaceStoreClient(workspaceId ?? '');
  const [favorites, setFavorites] = useState<string[]>([]);

  useEffect(() => {
    if (!client) {
      setFavorites([]);
      return;
    }
    let cancelled = false;
    const update = async (): Promise<void> => {
      const list = await client.query<string[]>('getFavorites', []);
      if (!cancelled) {
        setFavorites(list);
      }
    };
    update();
    const unsubscribe = client.subscribe(null, update);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [client]);

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
      mutateAsync(nodeUuid).catch(() => {});
    },
    [mutateAsync]
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
      mutateAsync(nodeUuid).catch(() => {});
    },
    [mutateAsync]
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
      mutateAsync({ fromIndex, toIndex }).catch(() => {});
    },
    [mutateAsync]
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

export async function isFavorite(
  workspaceId: string | undefined,
  nodeUuid: string
): Promise<boolean> {
  if (!workspaceId || !nodeUuid) return false;
  const client = getWorkspaceStoreClient(workspaceId);
  if (!client) return false;
  const favorites = await client.query<string[]>('getFavorites', []);
  return favorites.includes(nodeUuid);
}
