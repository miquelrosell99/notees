/**
 * Favorites local-first state backed by a persisted Zustand store.
 *
 * Provides query/mutation-shaped hooks for components and imperative helpers
 * for non-component code (mutation callbacks, dynamic imports, etc.).
 */
import { useFavoritesStore } from '@/stores/favoritesStore';

export function useFavorites() {
  const favorites = useFavoritesStore((state) => state.favorites);
  return { data: favorites, isLoading: false, error: null };
}

export function useAddFavoriteMutation() {
  const addFavorite = useFavoritesStore((state) => state.addFavorite);
  return {
    mutate: (nodeUuid: string) => addFavorite(nodeUuid),
    mutateAsync: async (nodeUuid: string) => addFavorite(nodeUuid),
  } as {
    mutate: (nodeUuid: string) => void;
    mutateAsync: (nodeUuid: string) => Promise<void>;
  };
}

export function useRemoveFavoriteMutation() {
  const removeFavorite = useFavoritesStore((state) => state.removeFavorite);
  return {
    mutate: (nodeUuid: string) => removeFavorite(nodeUuid),
    mutateAsync: async (nodeUuid: string) => removeFavorite(nodeUuid),
  } as {
    mutate: (nodeUuid: string) => void;
    mutateAsync: (nodeUuid: string) => Promise<void>;
  };
}

export function useReorderFavoritesMutation() {
  const reorderFavorites = useFavoritesStore((state) => state.reorderFavorites);
  return {
    mutate: ({ fromIndex, toIndex }: { fromIndex: number; toIndex: number }) =>
      reorderFavorites(fromIndex, toIndex),
    mutateAsync: async ({ fromIndex, toIndex }: { fromIndex: number; toIndex: number }) =>
      reorderFavorites(fromIndex, toIndex),
  } as {
    mutate: (args: { fromIndex: number; toIndex: number }) => void;
    mutateAsync: (args: { fromIndex: number; toIndex: number }) => Promise<void>;
  };
}

export async function addFavorite(nodeUuid: string): Promise<string[]> {
  useFavoritesStore.getState().addFavorite(nodeUuid);
  return useFavoritesStore.getState().favorites;
}

export async function removeFavorite(nodeUuid: string): Promise<string[]> {
  useFavoritesStore.getState().removeFavorite(nodeUuid);
  return useFavoritesStore.getState().favorites;
}

export async function reorderFavorites(fromIndex: number, toIndex: number): Promise<string[]> {
  useFavoritesStore.getState().reorderFavorites(fromIndex, toIndex);
  return useFavoritesStore.getState().favorites;
}

export function isFavorite(nodeUuid: string): boolean {
  return useFavoritesStore.getState().isFavorite(nodeUuid);
}
