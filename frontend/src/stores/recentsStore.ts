/**
 * Recents Store
 *
 * Client-side persisted list of recently opened page UUIDs. Recents were
 * previously tracked via `/api/nodes/recents` and `/api/nodes/:uuid/open`
 * (removed in Phase 8); they are now a local-first list stored in localStorage.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

const MAX_RECENTS = 50;

export interface RecentItem {
  nodeUuid: string;
  openDate: string;
}

interface RecentsState {
  /** Ordered list of recently opened nodes (most recent first). */
  recents: RecentItem[];

  /** Record a node as opened now (deduped, prepended, capped at MAX_RECENTS). */
  addRecent: (nodeUuid: string) => void;
  /** Remove a node from recents. */
  removeRecent: (nodeUuid: string) => void;
  /** Clear the entire recents list. */
  clearRecents: () => void;
}

export const useRecentsStore = create<RecentsState>()(
  persist(
    (set) => ({
      recents: [],

      addRecent: (nodeUuid) =>
        set((state) => {
          const openDate = new Date().toISOString();
          const filtered = state.recents.filter((item) => item.nodeUuid !== nodeUuid);
          const next = [{ nodeUuid, openDate }, ...filtered];
          if (next.length > MAX_RECENTS) {
            next.length = MAX_RECENTS;
          }
          return { recents: next };
        }),

      removeRecent: (nodeUuid) =>
        set((state) => ({
          recents: state.recents.filter((item) => item.nodeUuid !== nodeUuid),
        })),

      clearRecents: () => set({ recents: [] }),
    }),
    {
      name: 'notees-recents',
      partialize: (state) => ({ recents: state.recents }),
    }
  )
);
