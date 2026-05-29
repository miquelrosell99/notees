/**
 * livePresenceStore — Zustand store for tracking which remote users are
 * focused on which blocks in real time.
 */

import { create } from 'zustand';

export interface PresenceUser {
  id: number;
  name: string;
  color: string;
}

interface PagePresence {
  [blockUuid: string]: PresenceUser[];
}

interface LivePresenceState {
  /** pageUuid -> blockUuid -> users */
  presence: Record<string, PagePresence>;
  /** The block uuid that the LOCAL user is currently focused on */
  localFocus: Record<string, string | null>;

  setUserFocus(pageUuid: string, blockUuid: string, user: PresenceUser): void;
  removeUserFocus(pageUuid: string, blockUuid: string, userId: number): void;
  removeUserFromPage(pageUuid: string, userId: number): void;
  setLocalFocus(pageUuid: string, blockUuid: string | null): void;
  getUsersOnBlock(pageUuid: string, blockUuid: string): PresenceUser[];
  getLocalFocus(pageUuid: string): string | null;
}

export const useLivePresenceStore = create<LivePresenceState>()((set, get) => ({
  presence: {},
  localFocus: {},

  setUserFocus(pageUuid, blockUuid, user) {
    set((state) => {
      const page = state.presence[pageUuid] ?? {};
      const list = page[blockUuid] ?? [];
      // Replace existing entry for this user
      const filtered = list.filter((u) => u.id !== user.id);
      const nextPage = {
        ...page,
        [blockUuid]: [...filtered, user],
      };
      return {
        presence: { ...state.presence, [pageUuid]: nextPage },
      };
    });
  },

  removeUserFocus(pageUuid, blockUuid, userId) {
    set((state) => {
      const page = state.presence[pageUuid];
      if (!page) return state;
      const list = page[blockUuid];
      if (!list) return state;
      const filtered = list.filter((u) => u.id !== userId);
      if (filtered.length === list.length) return state;
      const nextPage = { ...page };
      if (filtered.length === 0) {
        delete nextPage[blockUuid];
      } else {
        nextPage[blockUuid] = filtered;
      }
      return {
        presence: { ...state.presence, [pageUuid]: nextPage },
      };
    });
  },

  removeUserFromPage(pageUuid, userId) {
    set((state) => {
      const page = state.presence[pageUuid];
      if (!page) return state;
      const nextPage: PagePresence = {};
      let changed = false;
      for (const [blockUuid, list] of Object.entries(page)) {
        const filtered = list.filter((u) => u.id !== userId);
        if (filtered.length !== list.length) changed = true;
        if (filtered.length > 0) nextPage[blockUuid] = filtered;
      }
      if (!changed) return state;
      return {
        presence: { ...state.presence, [pageUuid]: nextPage },
      };
    });
  },

  setLocalFocus(pageUuid, blockUuid) {
    set((state) => ({
      localFocus: { ...state.localFocus, [pageUuid]: blockUuid },
    }));
  },

  getUsersOnBlock(pageUuid, blockUuid) {
    return get().presence[pageUuid]?.[blockUuid] ?? [];
  },

  getLocalFocus(pageUuid) {
    return get().localFocus[pageUuid] ?? null;
  },
}));
