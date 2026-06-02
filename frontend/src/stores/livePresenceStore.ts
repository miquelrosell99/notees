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

interface TypingEntry {
  user: PresenceUser;
  expiresAt: number;
}

interface PageTyping {
  [blockUuid: string]: TypingEntry[];
}

interface LivePresenceState {
  /** nodeUuid -> blockUuid -> users (focused, not necessarily locked) */
  presence: Record<string, PagePresence>;
  /** nodeUuid -> blockUuid -> lock owner */
  locks: Record<string, PageLocks>;
  /** nodeUuid -> blockUuid -> users currently typing */
  typing: Record<string, PageTyping>;
  /** The block uuid that the LOCAL user is currently focused on */
  localFocus: Record<string, string | null>;

  setUserFocus(nodeUuid: string, blockUuid: string, user: PresenceUser): void;
  removeUserFocus(nodeUuid: string, blockUuid: string, userId: number): void;
  removeUserFromPage(nodeUuid: string, userId: number): void;
  setLocalFocus(nodeUuid: string, blockUuid: string | null): void;
  getUsersOnBlock(nodeUuid: string, blockUuid: string): PresenceUser[];
  getLocalFocus(nodeUuid: string): string | null;

  setLockOwner(nodeUuid: string, blockUuid: string, user: PresenceUser): void;
  removeLockOwner(nodeUuid: string, blockUuid: string): void;
  getLockOwner(nodeUuid: string, blockUuid: string): PresenceUser | undefined;

  setUserTyping(nodeUuid: string, blockUuid: string, user: PresenceUser, ttlMs?: number): void;
  clearUserTyping(nodeUuid: string, blockUuid: string, userId: number): void;
  getTypingUsersOnBlock(nodeUuid: string, blockUuid: string): PresenceUser[];
}

const EMPTY_USERS: PresenceUser[] = [];

export const useLivePresenceStore = create<LivePresenceState>((set, get) => ({
  presence: {},
  locks: {},
  typing: {},
  localFocus: {},

  setUserFocus(nodeUuid, blockUuid, user) {
    set((state) => {
      const page = state.presence[nodeUuid] ?? {};
      const list = page[blockUuid] ?? [];
      // Replace existing entry for this user
      const filtered = list.filter((u) => u.id !== user.id);
      const nextPage = {
        ...page,
        [blockUuid]: [...filtered, user],
      };
      return {
        presence: { ...state.presence, [nodeUuid]: nextPage },
      };
    });
  },

  removeUserFocus(nodeUuid, blockUuid, userId) {
    set((state) => {
      const page = state.presence[nodeUuid];
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
        presence: { ...state.presence, [nodeUuid]: nextPage },
      };
    });
  },

  removeUserFromPage(nodeUuid, userId) {
    set((state) => {
      const page = state.presence[nodeUuid];
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
        presence: { ...state.presence, [nodeUuid]: nextPage },
      };
    });
  },

  setLocalFocus(nodeUuid, blockUuid) {
    set((state) => ({
      localFocus: { ...state.localFocus, [nodeUuid]: blockUuid },
    }));
  },

  getUsersOnBlock(nodeUuid, blockUuid) {
    return get().presence[nodeUuid]?.[blockUuid] ?? EMPTY_USERS;
  },

  getLocalFocus(nodeUuid) {
    return get().localFocus[nodeUuid] ?? null;
  },

  setLockOwner(nodeUuid, blockUuid, user) {
    set((state) => {
      const pageLocks = state.locks[nodeUuid] ?? {};
      return {
        locks: {
          ...state.locks,
          [nodeUuid]: { ...pageLocks, [blockUuid]: user },
        },
      };
    });
  },

  removeLockOwner(nodeUuid, blockUuid) {
    set((state) => {
      const pageLocks = state.locks[nodeUuid];
      if (!pageLocks) return state;
      const nextLocks = { ...pageLocks };
      delete nextLocks[blockUuid];
      if (Object.keys(nextLocks).length === 0) {
        const allLocks = { ...state.locks };
        delete allLocks[nodeUuid];
        return { locks: allLocks };
      }
      return {
        locks: { ...state.locks, [nodeUuid]: nextLocks },
      };
    });
  },

  getLockOwner(nodeUuid, blockUuid) {
    return get().locks[nodeUuid]?.[blockUuid];
  },

  setUserTyping(nodeUuid, blockUuid, user, ttlMs = 3000) {
    const expiresAt = Date.now() + ttlMs;
    set((state) => {
      const page = state.typing[nodeUuid] ?? {};
      const list = page[blockUuid] ?? [];
      const filtered = list.filter((e) => e.user.id !== user.id);
      const nextPage = {
        ...page,
        [blockUuid]: [...filtered, { user, expiresAt }],
      };
      return {
        typing: { ...state.typing, [nodeUuid]: nextPage },
      };
    });
  },

  clearUserTyping(nodeUuid, blockUuid, userId) {
    set((state) => {
      const page = state.typing[nodeUuid];
      if (!page) return state;
      const list = page[blockUuid];
      if (!list) return state;
      const filtered = list.filter((e) => e.user.id !== userId);
      if (filtered.length === list.length) return state;
      const nextPage = { ...page };
      if (filtered.length === 0) {
        delete nextPage[blockUuid];
      } else {
        nextPage[blockUuid] = filtered;
      }
      return {
        typing: { ...state.typing, [nodeUuid]: nextPage },
      };
    });
  },

  getTypingUsersOnBlock(nodeUuid, blockUuid) {
    const now = Date.now();
    const entries = get().typing[nodeUuid]?.[blockUuid];
    if (!entries || entries.length === 0) return EMPTY_USERS;
    const active = entries.filter((e) => e.expiresAt > now);
    if (active.length === 0) return EMPTY_USERS;
    return active.map((e) => e.user);
  },
}));
