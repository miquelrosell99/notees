/**
 * Pinned Pages Store
 *
 * Per-session list of pages the user pinned from the sidebar. Deliberately
 * NOT persisted (no `persist` middleware): pins live only for the current
 * browser session and reset on reload.
 *
 * Order is insertion order (new pins are appended).
 */
import { create } from 'zustand';

interface PinnedPagesState {
  /** UUIDs of pinned pages, in pin order */
  pinnedPages: string[];

  /** Pin a page. Idempotent — no duplicate entries. */
  pinPage: (uuid: string) => void;
  /** Remove a page from the pinned list. */
  unpinPage: (uuid: string) => void;
  /** Pin the page if absent, unpin it if present. */
  togglePin: (uuid: string) => void;
}

export const usePinnedPagesStore = create<PinnedPagesState>((set) => ({
  pinnedPages: [],

  pinPage: (uuid) =>
    set((state) =>
      state.pinnedPages.includes(uuid)
        ? state
        : { pinnedPages: [...state.pinnedPages, uuid] }
    ),
  unpinPage: (uuid) =>
    set((state) => ({
      pinnedPages: state.pinnedPages.filter((pinned) => pinned !== uuid),
    })),
  togglePin: (uuid) =>
    set((state) =>
      state.pinnedPages.includes(uuid)
        ? { pinnedPages: state.pinnedPages.filter((pinned) => pinned !== uuid) }
        : { pinnedPages: [...state.pinnedPages, uuid] }
    ),
}));
