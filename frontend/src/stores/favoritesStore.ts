/**
 * Favorites Store
 *
 * Client-side persisted list of favorite page UUIDs. Favorites were previously
 * backed by `/api/nodes/favorites` (removed in Phase 8); they are now a
 * local-first ordered list stored in localStorage.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface FavoritesState {
  /** Ordered list of favorite node UUIDs. */
  favorites: string[];

  /** Add a node to favorites (idempotent, appended at the end). */
  addFavorite: (nodeUuid: string) => void;
  /** Remove a node from favorites. */
  removeFavorite: (nodeUuid: string) => void;
  /** Move a favorite from one position to another. */
  reorderFavorites: (fromIndex: number, toIndex: number) => void;
  /** Check whether a node is currently favorited. */
  isFavorite: (nodeUuid: string) => boolean;
  /** Remove all favorites (e.g. on workspace switch). */
  clearFavorites: () => void;
}

export const useFavoritesStore = create<FavoritesState>()(
  persist(
    (set, get) => ({
      favorites: [],

      addFavorite: (nodeUuid) =>
        set((state) =>
          state.favorites.includes(nodeUuid)
            ? state
            : { favorites: [...state.favorites, nodeUuid] }
        ),

      removeFavorite: (nodeUuid) =>
        set((state) => ({
          favorites: state.favorites.filter((uuid) => uuid !== nodeUuid),
        })),

      reorderFavorites: (fromIndex, toIndex) =>
        set((state) => {
          const { favorites } = state;
          if (
            fromIndex < 0 ||
            fromIndex >= favorites.length ||
            toIndex < 0 ||
            toIndex >= favorites.length ||
            fromIndex === toIndex
          ) {
            return state;
          }
          const next = [...favorites];
          const [moved] = next.splice(fromIndex, 1);
          next.splice(toIndex, 0, moved);
          return { favorites: next };
        }),

      isFavorite: (nodeUuid) => get().favorites.includes(nodeUuid),

      clearFavorites: () => set({ favorites: [] }),
    }),
    {
      name: 'notees-favorites',
      partialize: (state) => ({ favorites: state.favorites }),
    }
  )
);
