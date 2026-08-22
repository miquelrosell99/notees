/**
 * Navigation store — manages app navigation state and sidebar layout.
 *
 * Extracted from the legacy god-object appStore to isolate navigation
 * changes from modal-flag and display-preference re-renders.
 *
 * Type aliases (ViewMode, MainViewType, etc.) are defined in appStore.ts
 * and re-exported through stores/index.ts — import them from '@/stores'.
 */
import { create } from 'zustand';
import type {
  ViewMode,
  MainViewType,
  SidebarTab,
  SidebarNodeType,
  RightSidebarContent,
  SidebarCard,
  SidebarCardType,
} from './appStore';
import type { QueryAST } from '@/types/queryAST';


interface SidebarNode {
  id: string;
  type: SidebarNodeType;
}

interface NavigationState {
  // Active / current node UUIDs only (full Node objects live in TanStack Query cache)
  activeNodeUuid: string | null;
  currentNodeUuid: string | null;
  currentPropertyContext: { propertyUuid: string; propertyName: string } | null;

  // Left sidebar
  sidebarOpen: boolean;
  isSidebarCollapsed: boolean;
  sidebarTab: SidebarTab;

  // Right sidebar
  rightSidebarOpen: boolean;
  rightSidebarContent: RightSidebarContent;
  sidebarNode: SidebarNode | null;
  sidebarCards: SidebarCard[];
  localGraphNodeUuid: string | null;
  flashSidebarCardId: string | null;

  // View / layout
  viewMode: ViewMode;
  /** Sidebar collapsed state captured on focus-mode entry, restored on exit */
  preFocusModeSidebarCollapsed: boolean | null;
  mainViewType: MainViewType;
  currentPropertyUuid: string | null;

  // Workspace switching
  isSwitchingWorkspace: boolean;

  // Temporary node collection view (UUIDs only; full nodes fetched on demand)
  nodeCollectionTitle: string | null;
  nodeCollectionQueryAST: QueryAST | null;
  nodeCollectionNodeUuids: string[] | null;

  // Actions
  setActiveNodeUuid: (uuid: string | null) => void;
  openNode: (nodeUuid: string, propertyContext?: { propertyUuid: string; propertyName: string }) => void;
  toggleSidebar: () => void;
  toggleRightSidebar: () => void;
  setViewMode: (mode: ViewMode) => void;
  toggleFocusMode: () => void;
  setMainViewType: (viewType: MainViewType) => void;
  setSwitchingWorkspace: (value: boolean) => void;
  openPropertyView: (propertyUuid: string) => void;
  openNodeCollection: (title: string, queryAST: QueryAST) => void;
  openNodeCollectionFromNodes: (title: string, nodeUuids: string[]) => void;
  closeNodeCollection: () => void;
  setSidebarTab: (tab: SidebarTab) => void;
  openNodeInSidebar: (nodeUuid: string, nodeType: SidebarNodeType) => void;
  closeSidebarNode: () => void;
  addSidebarCard: (nodeUuid: string, cardType: SidebarCardType) => void;
  addSidebarCards: (nodeUuids: string[], cardType: SidebarCardType) => void;
  removeSidebarCard: (cardId: string) => void;
  clearSidebarCards: () => void;
  flashSidebarCard: (cardId: string) => void;
  openLocalGraph: (nodeUuid: string) => void;
  closeLocalGraph: () => void;
}

// Timer handle for flashSidebarCard — kept at module scope so overlapping
// flashes cancel the previous reset instead of scheduling independent timeouts.
let flashSidebarCardTimer: ReturnType<typeof setTimeout> | null = null;

export const useNavigationStore = create<NavigationState>()((set) => ({
  activeNodeUuid: null,
  currentNodeUuid: null,
  currentPropertyContext: null,
  sidebarOpen: true,
  rightSidebarOpen: false,
  isSidebarCollapsed: false,
  sidebarTab: 'pages',
  rightSidebarContent: null,
  sidebarNode: null,
  sidebarCards: [],
  localGraphNodeUuid: null,
  flashSidebarCardId: null,
  viewMode: 'default',
  preFocusModeSidebarCollapsed: null,
  mainViewType: 'node' as MainViewType,
  currentPropertyUuid: null,
  isSwitchingWorkspace: false,
  nodeCollectionTitle: null,
  nodeCollectionQueryAST: null,
  nodeCollectionNodeUuids: null,

  setActiveNodeUuid: (uuid) => set({ activeNodeUuid: uuid }),

  openNode: (nodeUuid, propertyContext) =>
    set({
      currentNodeUuid: nodeUuid,
      mainViewType: 'node',
      currentPropertyUuid: null,
      currentPropertyContext: propertyContext ?? null,
    }),

  toggleSidebar: () =>
    set((s) => ({ sidebarOpen: !s.sidebarOpen, isSidebarCollapsed: !s.isSidebarCollapsed })),
  toggleRightSidebar: () => set((s) => ({ rightSidebarOpen: !s.rightSidebarOpen })),
  setViewMode: (mode) => set({ viewMode: mode }),
  toggleFocusMode: () =>
    set((s) => {
      if (s.viewMode === 'focus') {
        return {
          viewMode: 'default',
          isSidebarCollapsed: s.preFocusModeSidebarCollapsed ?? s.isSidebarCollapsed,
          sidebarOpen: !(s.preFocusModeSidebarCollapsed ?? s.isSidebarCollapsed),
          preFocusModeSidebarCollapsed: null,
        };
      }
      return {
        viewMode: 'focus',
        preFocusModeSidebarCollapsed: s.isSidebarCollapsed,
        isSidebarCollapsed: true,
        sidebarOpen: false,
      };
    }),

  setSwitchingWorkspace: (value) => set({ isSwitchingWorkspace: value }),

  setMainViewType: (viewType) =>
    set({ mainViewType: viewType, currentNodeUuid: null, currentPropertyUuid: null }),

  openPropertyView: (propertyUuid) => {
    if (!propertyUuid) return;
    set({ mainViewType: 'property', currentPropertyUuid: propertyUuid, currentNodeUuid: null });
  },

  openNodeCollection: (title, queryAST) =>
    set({
      mainViewType: 'node-collection',
      nodeCollectionTitle: title,
      nodeCollectionQueryAST: queryAST,
      nodeCollectionNodeUuids: null,
      currentNodeUuid: null,
      currentPropertyUuid: null,
    }),
  openNodeCollectionFromNodes: (title, nodeUuids) =>
    set({
      mainViewType: 'node-collection',
      nodeCollectionTitle: title,
      nodeCollectionQueryAST: null,
      nodeCollectionNodeUuids: nodeUuids,
      currentNodeUuid: null,
      currentPropertyUuid: null,
    }),
  closeNodeCollection: () =>
    set({ mainViewType: 'node', nodeCollectionTitle: null, nodeCollectionQueryAST: null, nodeCollectionNodeUuids: null }),
  setSidebarTab: (tab) => set({ sidebarTab: tab }),
  openNodeInSidebar: (nodeUuid, nodeType) => {
    set({ rightSidebarOpen: true, rightSidebarContent: 'node', sidebarNode: { id: nodeUuid, type: nodeType } });
  },
  closeSidebarNode: () => set({ rightSidebarOpen: false, rightSidebarContent: null, sidebarNode: null }),
  addSidebarCard: (nodeUuid, cardType) => {
    set((s) => {
      const existingIndex = s.sidebarCards.findIndex(
        (c) => c.nodeUuid === nodeUuid && c.cardType === cardType,
      );
      if (existingIndex >= 0) {
        const existing = s.sidebarCards[existingIndex];
        const newCards = [
          { ...existing, addedAt: Date.now() },
          ...s.sidebarCards.slice(0, existingIndex),
          ...s.sidebarCards.slice(existingIndex + 1),
        ];
        return { sidebarCards: newCards, rightSidebarOpen: true, rightSidebarContent: 'node' };
      }
      const newCard: SidebarCard = { nodeUuid, cardType, addedAt: Date.now() };
      return {
        sidebarCards: [newCard, ...s.sidebarCards],
        rightSidebarOpen: true,
        rightSidebarContent: 'node',
      };
    });
  },
  addSidebarCards: (nodeUuids, cardType) => {
    set((s) => {
      const baseTime = Date.now();
      const newCards: SidebarCard[] = [];
      const existingCards = [...s.sidebarCards];

      nodeUuids.forEach((nodeUuid, index) => {
        const existingIndex = existingCards.findIndex(
          (c) => c.nodeUuid === nodeUuid && c.cardType === cardType,
        );
        if (existingIndex >= 0) {
          const existing = existingCards.splice(existingIndex, 1)[0];
          newCards.push({ ...existing, addedAt: baseTime + index });
        } else {
          newCards.push({ nodeUuid, cardType, addedAt: baseTime + index });
        }
      });

      return {
        sidebarCards: [...newCards, ...existingCards],
        rightSidebarOpen: true,
        rightSidebarContent: 'node',
      };
    });
  },
  removeSidebarCard: (cardId) =>
    set((s) => {
      const newCards = s.sidebarCards.filter((c) => c.nodeUuid !== cardId);
      if (newCards.length === 0) {
        return { sidebarCards: newCards, rightSidebarOpen: false, rightSidebarContent: null };
      }
      return { sidebarCards: newCards };
    }),
  clearSidebarCards: () => set({ sidebarCards: [], rightSidebarOpen: false, rightSidebarContent: null }),
  flashSidebarCard: (cardId) => {
    set({ flashSidebarCardId: cardId, rightSidebarOpen: true, rightSidebarContent: 'node' });
    if (flashSidebarCardTimer) {
      clearTimeout(flashSidebarCardTimer);
    }
    flashSidebarCardTimer = setTimeout(() => {
      flashSidebarCardTimer = null;
      set({ flashSidebarCardId: null });
    }, 1500);
  },
  openLocalGraph: (nodeUuid) => {
    set((s) => {
      const existingIndex = s.sidebarCards.findIndex(
        (c) => c.nodeUuid === nodeUuid && c.cardType === 'localGraph',
      );
      if (existingIndex >= 0) {
        const existing = s.sidebarCards[existingIndex];
        const newCards = [
          { ...existing, addedAt: Date.now() },
          ...s.sidebarCards.slice(0, existingIndex),
          ...s.sidebarCards.slice(existingIndex + 1),
        ];
        return {
          sidebarCards: newCards,
          rightSidebarOpen: true,
          rightSidebarContent: 'node',
          localGraphNodeUuid: nodeUuid,
        };
      }
      const newCard: SidebarCard = {
        nodeUuid,
        cardType: 'localGraph',
        addedAt: Date.now(),
      };
      return {
        sidebarCards: [newCard, ...s.sidebarCards],
        rightSidebarOpen: true,
        rightSidebarContent: 'node',
        localGraphNodeUuid: nodeUuid,
      };
    });
  },
  closeLocalGraph: () =>
    set((s) => {
      const newCards = s.sidebarCards.filter((c) => c.cardType !== 'localGraph');
      if (newCards.length === 0) {
        return { sidebarCards: newCards, rightSidebarOpen: false, rightSidebarContent: null, localGraphNodeUuid: null };
      }
      return { sidebarCards: newCards, localGraphNodeUuid: null };
    }),
}));
