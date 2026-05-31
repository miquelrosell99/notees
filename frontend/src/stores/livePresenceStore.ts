/**
 * livePresenceStore — Zustand store for tracking which remote users are
 * focused on which blocks in real time, and who holds block locks.
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

interface PageLocks {
  [blockUuid: string]: PresenceUser | undefined;
}

interface LivePresenceState {
  /** pageUuid -> blockUuid -> users (focused, not necessarily locked) */
  presence: Record<string, PagePresence>;
  /** pageUuid -> blockUuid -> lock owner */
  locks: Record<string, PageLocks>;
  /** The block uuid that the LOCAL user is currently focused on */
  localFocus: Record<string, string | null>;

  setUserFocus(pageUuid: string, blockUuid: string, user: PresenceUser): void;
  removeUserFocus(pageUuid: string, blockUuid: string, userId: number): void;
  removeUserFromPage(pageUuid: string, userId: number): void;
  setLocalFocus(pageUuid: string, blockUuid: string | null): void;
  getUsersOnBlock(pageUuid: string, blockUuid: string): PresenceUser[];
  getLocalFocus(pageUuid: string): string | null;

  setLockOwner(pageUuid: string, blockUuid: string, user: PresenceUser): void;
  removeLockOwner(pageUuid: string, blockUuid: string): void;
  getLockOwner(pageUuid: string, blockUuid: string): PresenceUser | undefined;
}

export const useLivePresenceStore = create<LivePresenceState>()((set, get) => ({
  presence: {},
  locks: {},
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

  setLockOwner(pageUuid, blockUuid, user) {
    set((state) => {
      const pageLocks = state.locks[pageUuid] ?? {};
      return {
        locks: {
          ...state.locks,
          [pageUuid]: { ...pageLocks, [blockUuid]: user },
        },
      };
    });
  },

  removeLockOwner(pageUuid, blockUuid) {
    set((state) => {
      const pageLocks = state.locks[pageUuid];
      if (!pageLocks) return state;
      const nextLocks = { ...pageLocks };
      delete nextLocks[blockUuid];
      if (Object.keys(nextLocks).length === 0) {
        const allLocks = { ...state.locks };
        delete allLocks[pageUuid];
        return { locks: allLocks };
      }
      return {
        locks: { ...state.locks, [pageUuid]: nextLocks },
      };
    });
  },

  getLockOwner(pageUuid, blockUuid) {
    return get().locks[pageUuid]?.[blockUuid];
  },
}));
