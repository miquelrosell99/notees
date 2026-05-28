/**
 * FindReplaceStore — Page-scoped find & replace state.
 */

import { create } from 'zustand';

export interface Match {
  nodeKey: string;
  offset: number;
  length: number;
  text: string;
}

interface FindReplaceState {
  isOpen: boolean;
  query: string;
  replaceText: string;
  matchIndex: number;
  totalMatches: number;
  caseSensitive: boolean;
  replaceExpanded: boolean;
  matches: Match[];
  open(): void;
  close(): void;
  toggleReplaceExpanded(): void;
  setQuery(q: string): void;
  setReplaceText(t: string): void;
  setMatchIndex(i: number): void;
  setTotalMatches(n: number): void;
  setMatches(m: Match[]): void;
  toggleCaseSensitive(): void;
}

export const useFindReplaceStore = create<FindReplaceState>((set) => ({
  isOpen: false,
  query: '',
  replaceText: '',
  matchIndex: 0,
  totalMatches: 0,
  caseSensitive: false,
  replaceExpanded: false,
  matches: [],
  open: () => set({ isOpen: true }),
  close: () =>
    set({ isOpen: false, query: '', replaceText: '', matchIndex: 0, totalMatches: 0, matches: [], replaceExpanded: false }),
  toggleReplaceExpanded: () => set((s) => ({ replaceExpanded: !s.replaceExpanded })),
  setQuery: (q) => set({ query: q }),
  setReplaceText: (t) => set({ replaceText: t }),
  setMatchIndex: (i) => set({ matchIndex: i }),
  setTotalMatches: (n) => set({ totalMatches: n }),
  setMatches: (m) => set({ matches: m }),
  toggleCaseSensitive: () => set((s) => ({ caseSensitive: !s.caseSensitive })),
}));
