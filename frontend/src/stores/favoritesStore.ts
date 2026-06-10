/**
 * Favorites and Recents store using Zustand
 * 
 * Manages:
 * - Favorites: User-pinned pages that appear in sidebar, stored in DB per-database
 * - Recents: Recently opened pages, based on open_date field in DB
 * 
 * Data is fetched from the backend API. localStorage is no longer used.
 */
import { create } from 'zustand';
import * as nodesApi from '@/api/nodes';
import { getLogger } from '@/utils/logger';

const log = getLogger('favoritesStore');

/** Maximum number of recent pages to display */
const MAX_RECENTS = 10;

export interface FavoriteItem {
  nodeId: number;
}

export interface RecentItem {
  nodeId: number;
  openDate: string;
}

interface FavoritesState {
  // Loading states
  isLoadingFavorites: boolean;
  isLoadingRecents: boolean;
  
  // Data
  favorites: FavoriteItem[];
  recents: RecentItem[];
  
  // Actions for favorites
  loadFavorites: () => Promise<void>;
  addFavorite: (nodeId: number) => Promise<void>;
  removeFavorite: (nodeId: number) => Promise<void>;
  isFavorite: (nodeId: number) => boolean;
  reorderFavorites: (fromIndex: number, toIndex: number) => Promise<void>;
  
  // Actions for recents
  loadRecents: () => Promise<void>;
  removeRecent: (nodeId: number) => void;
  
  // Clear all data (used when switching workspaces)
  clear: () => void;
  
  // Refresh both
  refresh: () => Promise<void>;
}

export const useFavoritesStore = create<FavoritesState>()((set, get) => ({
  isLoadingFavorites: false,
  isLoadingRecents: false,
  favorites: [],
  recents: [],
  
  loadFavorites: async () => {
    set({ isLoadingFavorites: true });
    try {
      const response = await nodesApi.getFavorites();
      set({
        favorites: response.items.map((node) => ({ nodeId: node.id })),
        isLoadingFavorites: false,
      });
    } catch (error) {
      log.error('Failed to load favorites', error);
      set({ isLoadingFavorites: false });
    }
  },
  
  addFavorite: async (nodeId: number) => {
    const { favorites } = get();
    // Optimistic update
    if (!favorites.some(f => f.nodeId === nodeId)) {
      set({ favorites: [...favorites, { nodeId }] });
    }
    
    try {
      const newFavorites = await nodesApi.addFavorite(nodeId);
      set({ favorites: newFavorites.map(id => ({ nodeId: id })) });
    } catch (error) {
      log.error('Failed to add favorite', error);
      // Revert on error
      set({ favorites });
    }
  },
  
  removeFavorite: async (nodeId: number) => {
    const { favorites } = get();
    // Optimistic update — keep removed even if API fails (node may be deleted)
    set({ favorites: favorites.filter(f => f.nodeId !== nodeId) });
    
    try {
      const newFavorites = await nodesApi.removeFavorite(nodeId);
      set({ favorites: newFavorites.map(id => ({ nodeId: id })) });
    } catch (error) {
      log.error('Failed to remove favorite', error);
      // Do not revert — the node is likely deleted and should stay removed
    }
  },
  
  isFavorite: (nodeId: number) => {
    return get().favorites.some(f => f.nodeId === nodeId);
  },
  
  reorderFavorites: async (fromIndex: number, toIndex: number) => {
    const { favorites } = get();
    // Optimistic update
    const newFavorites = [...favorites];
    const [removed] = newFavorites.splice(fromIndex, 1);
    newFavorites.splice(toIndex, 0, removed);
    set({ favorites: newFavorites });
    
    try {
      const updatedFavorites = await nodesApi.reorderFavorites(fromIndex, toIndex);
      set({ favorites: updatedFavorites.map(id => ({ nodeId: id })) });
    } catch (error) {
      log.error('Failed to reorder favorites', error);
      // Revert on error
      set({ favorites });
    }
  },
  
  loadRecents: async () => {
    set({ isLoadingRecents: true });
    try {
      const recentPages = await nodesApi.getRecentPages(MAX_RECENTS);
      set({
        recents: recentPages.map(page => ({
          nodeId: page.id,
          openDate: page.open_date,
        })),
        isLoadingRecents: false,
      });
    } catch (error) {
      log.error('Failed to load recents', error);
      set({ isLoadingRecents: false });
    }
  },
  
  removeRecent: (nodeId: number) => {
    set(state => ({
      recents: state.recents.filter(item => item.nodeId !== nodeId),
    }));
  },
  
  clear: () => {
    set({
      favorites: [],
      recents: [],
      isLoadingFavorites: false,
      isLoadingRecents: false,
    });
  },
  
  refresh: async () => {
    await Promise.all([
      get().loadFavorites(),
      get().loadRecents(),
    ]);
  },
}));
