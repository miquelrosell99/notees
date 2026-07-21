/**
 * Favorites hooks backed by the workspace operation log.
 *
 * Favorites are stored as `user.favorite.*` operations in the local-first
 * SQLite derived store, so they sync across devices and survive browser data
 * clearing as long as the workspace relay is intact.
 */
import { useEffect, useState, useCallback } from 'react';
import { useWorkspaceStore } from '@/core/hooks/useWorkspaceStore';
import { getWorkspaceStore } from '@/core/adapters/workspaceStoreAdapter';
import type { WorkspaceStore } from '@/core/store';

export interface UseFavoritesResult {
  data: string[];
  isLoading: boolean;
  error: Error | null;
}

export function useFavorites(workspaceId: string | undefined): UseFavoritesResult {
  const { store, isLoading, error } = useWorkspaceStore(workspaceId ?? '');
  const [favorites, setFavorites] = useState<string[]>([]);

  useEffect(() => {
    if (!store) {
      setFavorites([]);
      return;
    }
    const update = (): void => setFavorites(store.getFavorites());
    update();
    return store.subscribeAll(update);
  }, [store]);

  return { data: favorites, isLoading, error };
}

function useFavoriteStore(workspaceId: string | undefined): WorkspaceStore | undefined {
  const { store } = useWorkspaceStore(workspaceId ?? '');
  return store;
}

export function useAddFavoriteMutation(workspaceId: string | undefined) {
  const store = useFavoriteStore(workspaceId);

  const mutate = useCallback(
    (nodeUuid: string) => {
      store?.addFavorite(nodeUuid);
    },
    [store]
  );

  const mutateAsync = useCallback(
    async (nodeUuid: string): Promise<void> => {
      if (!store) throw new Error('Workspace store is not ready');
      store.addFavorite(nodeUuid);
    },
    [store]
  );

  return { mutate, mutateAsync };
}

export function useRemoveFavoriteMutation(workspaceId: string | undefined) {
  const store = useFavoriteStore(workspaceId);

  const mutate = useCallback(
    (nodeUuid: string) => {
      store?.removeFavorite(nodeUuid);
    },
    [store]
  );

  const mutateAsync = useCallback(
    async (nodeUuid: string): Promise<void> => {
      if (!store) throw new Error('Workspace store is not ready');
      store.removeFavorite(nodeUuid);
    },
    [store]
  );

  return { mutate, mutateAsync };
}

export function useReorderFavoritesMutation(workspaceId: string | undefined) {
  const store = useFavoriteStore(workspaceId);

  const mutate = useCallback(
    ({ fromIndex, toIndex }: { fromIndex: number; toIndex: number }) => {
      if (!store) return;
      const favorites = store.getFavorites();
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
      store.reorderFavorites(next);
    },
    [store]
  );

  const mutateAsync = useCallback(
    async ({ fromIndex, toIndex }: { fromIndex: number; toIndex: number }): Promise<void> => {
      if (!store) throw new Error('Workspace store is not ready');
      const favorites = store.getFavorites();
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
      store.reorderFavorites(next);
    },
    [store]
  );

  return { mutate, mutateAsync };
}

export async function addFavorite(workspaceId: string | undefined, nodeUuid: string): Promise<string[]> {
  if (!workspaceId) return [];
  // Non-component callers don't have the workspace context; we reach for the
  // adapter which caches the active store.
  const store = getWorkspaceStore(workspaceId);
  if (!store) return [];
  store.addFavorite(nodeUuid);
  return store.getFavorites();
}

export async function removeFavorite(workspaceId: string | undefined, nodeUuid: string): Promise<string[]> {
  if (!workspaceId) return [];
  const store = getWorkspaceStore(workspaceId);
  if (!store) return [];
  store.removeFavorite(nodeUuid);
  return store.getFavorites();
}

export async function reorderFavorites(
  workspaceId: string | undefined,
  fromIndex: number,
  toIndex: number
): Promise<string[]> {
  if (!workspaceId) return [];
  const store = getWorkspaceStore(workspaceId);
  if (!store) return [];
  const favorites = store.getFavorites();
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
  store.reorderFavorites(next);
  return store.getFavorites();
}

export function isFavorite(workspaceId: string | undefined, nodeUuid: string): boolean {
  // Synchronous check is only available when a store instance is cached.
  // Components should use useFavorites and derive inclusion from there.
  if (!workspaceId || !nodeUuid) return false;
  return getWorkspaceStore(workspaceId)?.getFavorites().includes(nodeUuid) ?? false;
}
