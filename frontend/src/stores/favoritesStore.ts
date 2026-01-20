/**
 * Favorites and Recents store using Zustand
 * 
 * Manages:
 * - Favorites: User-pinned pages that appear in sidebar, stored per-database
 * - Recents: Recently accessed pages, tracked automatically per-database
 * 
 * Data is scoped per-database to prevent stale nodeIds from appearing
 * when switching databases or using a fresh database.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/** Maximum number of recent pages to track */
const MAX_RECENTS = 10;

export interface FavoriteItem {
  nodeId: number;
  addedAt: number; // timestamp for sorting
}

export interface RecentItem {
  nodeId: number;
  accessedAt: number; // timestamp
}

/** Per-database storage for favorites and recents */
interface DatabaseFavoritesData {
  favorites: FavoriteItem[];
  recents: RecentItem[];
}

interface FavoritesState {
  // Current database name (set when database changes)
  currentDatabase: string | null;
  
  // Per-database storage: { databaseName: { favorites, recents } }
  databaseData: Record<string, DatabaseFavoritesData>;
  
  // Computed: favorites for current database
  favorites: FavoriteItem[];
  
  // Computed: recents for current database
  recents: RecentItem[];
  
  // Set the current database (call when database changes)
  setCurrentDatabase: (dbName: string | null) => void;
  
  // Actions for favorites
  addFavorite: (nodeId: number) => void;
  removeFavorite: (nodeId: number) => void;
  isFavorite: (nodeId: number) => boolean;
  reorderFavorites: (fromIndex: number, toIndex: number) => void;
  
  // Actions for recents
  addRecent: (nodeId: number) => void;
  clearRecents: () => void;
}

/** Helper to get or create database data */
function getDbData(state: FavoritesState, dbName: string | null): DatabaseFavoritesData {
  if (!dbName) return { favorites: [], recents: [] };
  return state.databaseData[dbName] || { favorites: [], recents: [] };
}

export const useFavoritesStore = create<FavoritesState>()(
  persist(
    (set, get) => ({
      currentDatabase: null,
      databaseData: {},
      favorites: [],
      recents: [],
      
      setCurrentDatabase: (dbName: string | null) => {
        const data = getDbData(get(), dbName);
        set({
          currentDatabase: dbName,
          favorites: data.favorites,
          recents: data.recents,
        });
      },
      
      addFavorite: (nodeId: number) => {
        const { currentDatabase, databaseData } = get();
        if (!currentDatabase) return;
        
        const dbData = getDbData(get(), currentDatabase);
        // Don't add duplicates
        if (dbData.favorites.some(f => f.nodeId === nodeId)) {
          return;
        }
        const newFavorites = [...dbData.favorites, { nodeId, addedAt: Date.now() }];
        set({
          databaseData: {
            ...databaseData,
            [currentDatabase]: { ...dbData, favorites: newFavorites }
          },
          favorites: newFavorites,
        });
      },
      
      removeFavorite: (nodeId: number) => {
        const { currentDatabase, databaseData } = get();
        if (!currentDatabase) return;
        
        const dbData = getDbData(get(), currentDatabase);
        const newFavorites = dbData.favorites.filter(f => f.nodeId !== nodeId);
        set({
          databaseData: {
            ...databaseData,
            [currentDatabase]: { ...dbData, favorites: newFavorites }
          },
          favorites: newFavorites,
        });
      },
      
      isFavorite: (nodeId: number) => {
        const { favorites } = get();
        return favorites.some(f => f.nodeId === nodeId);
      },
      
      reorderFavorites: (fromIndex: number, toIndex: number) => {
        const { currentDatabase, databaseData } = get();
        if (!currentDatabase) return;
        
        const dbData = getDbData(get(), currentDatabase);
        const newFavorites = [...dbData.favorites];
        const [removed] = newFavorites.splice(fromIndex, 1);
        newFavorites.splice(toIndex, 0, removed);
        set({
          databaseData: {
            ...databaseData,
            [currentDatabase]: { ...dbData, favorites: newFavorites }
          },
          favorites: newFavorites,
        });
      },
      
      addRecent: (nodeId: number) => {
        const { currentDatabase, databaseData } = get();
        if (!currentDatabase) return;
        
        const dbData = getDbData(get(), currentDatabase);
        // Remove existing entry for this node (to move it to front)
        const filtered = dbData.recents.filter(r => r.nodeId !== nodeId);
        // Add to front and limit to MAX_RECENTS
        const newRecents = [{ nodeId, accessedAt: Date.now() }, ...filtered].slice(0, MAX_RECENTS);
        set({
          databaseData: {
            ...databaseData,
            [currentDatabase]: { ...dbData, recents: newRecents }
          },
          recents: newRecents,
        });
      },
      
      clearRecents: () => {
        const { currentDatabase, databaseData } = get();
        if (!currentDatabase) return;
        
        const dbData = getDbData(get(), currentDatabase);
        set({
          databaseData: {
            ...databaseData,
            [currentDatabase]: { ...dbData, recents: [] }
          },
          recents: [],
        });
      },
    }),
    {
      name: 'notees-favorites',
      version: 2, // Bump version to trigger migration
      migrate: (persistedState: unknown, version: number) => {
        // Migration from v1 (global favorites/recents) to v2 (per-database)
        if (version < 2) {
          // Clear old data - we can't migrate because we don't know which database it belonged to
          return {
            currentDatabase: null,
            databaseData: {},
            favorites: [],
            recents: [],
          };
        }
        return persistedState as FavoritesState;
      },
    }
  )
);
