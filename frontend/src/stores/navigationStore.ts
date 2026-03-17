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
import type { Node } from '@/types';
import type {
  ViewMode,
  MainViewType,
  SidebarTab,
  SidebarNodeType,
  RightSidebarContent,
  SidebarCard,
  SidebarCardType,
} from './appStore';

interface SidebarNode {
  id: number;
  type: SidebarNodeType;
}

interface NavigationState {
  // Active / current node
  activeNode: Node | null;
  activeNodeId: number | null;
  currentNodeId: number | null;
  currentPropertyContext: { propertyId: number; propertyName: string } | null;

  // Left sidebar
  sidebarOpen: boolean;
  isSidebarCollapsed: boolean;
  sidebarTab: SidebarTab;

  // Right sidebar
  rightSidebarOpen: boolean;
  rightSidebarContent: RightSidebarContent;
  sidebarNode: SidebarNode | null;
  sidebarCards: SidebarCard[];
  localGraphNodeId: number | null;

  // View / layout
  viewMode: ViewMode;
  /** Sidebar collapsed state captured on focus-mode entry, restored on exit */
  preFocusModeSidebarCollapsed: boolean | null;
  mainViewType: MainViewType;
  currentPropertyId: number | null;

  // Actions
  setActiveNode: (node: Node | null) => void;
  setActiveNodeId: (id: number | null) => void;
  openNode: (nodeId: number, propertyContext?: { propertyId: number; propertyName: string }) => void;
  toggleSidebar: () => void;
  toggleRightSidebar: () => void;
  setViewMode: (mode: ViewMode) => void;
  toggleFocusMode: () => void;
  setMainViewType: (viewType: MainViewType) => void;
  openPropertyView: (propertyId: number) => void;
  setSidebarTab: (tab: SidebarTab) => void;
  openNodeInSidebar: (nodeId: number, nodeType: SidebarNodeType) => void;
  closeSidebarNode: () => void;
  addSidebarCard: (nodeId: number, cardType: SidebarCardType) => void;
  addSidebarCards: (nodeIds: number[], cardType: SidebarCardType) => void;
  removeSidebarCard: (cardId: number) => void;
  clearSidebarCards: () => void;
  openLocalGraph: (nodeId: number) => void;
  closeLocalGraph: () => void;
}

export const useNavigationStore = create<NavigationState>()((set, get) => ({
  activeNode: null,
  activeNodeId: null,
  currentNodeId: null,
  currentPropertyContext: null,
  sidebarOpen: true,
  rightSidebarOpen: false,
  isSidebarCollapsed: false,
  sidebarTab: 'pages',
  rightSidebarContent: null,
  sidebarNode: null,
  sidebarCards: [],
  localGraphNodeId: null,
  viewMode: 'default',
  preFocusModeSidebarCollapsed: null,
  mainViewType: 'node' as MainViewType,
  currentPropertyId: null,

  setActiveNode: (node) => set({ activeNode: node, activeNodeId: node?.id ?? null }),
  setActiveNodeId: (id) => set({ activeNodeId: id }),
  openNode: (nodeId, propertyContext) =>
    set({ currentNodeId: nodeId, currentPropertyContext: propertyContext ?? null, mainViewType: 'node' }),
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
  setMainViewType: (viewType) => set({ mainViewType: viewType }),
  openPropertyView: (propertyId) => set({ mainViewType: 'property', currentPropertyId: propertyId }),
  setSidebarTab: (tab) => set({ sidebarTab: tab }),
  openNodeInSidebar: (nodeId, nodeType) =>
    set({ rightSidebarOpen: true, rightSidebarContent: 'node', sidebarNode: { id: nodeId, type: nodeType } }),
  closeSidebarNode: () => set({ rightSidebarOpen: false, rightSidebarContent: null, sidebarNode: null }),
  addSidebarCard: (nodeId, cardType) =>
    set((s) => {
      const existingIndex = s.sidebarCards.findIndex(
        (c) => c.nodeId === nodeId && c.cardType === cardType,
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
      const newCard: SidebarCard = { id: Date.now(), nodeId, cardType, addedAt: Date.now() };
      return {
        sidebarCards: [newCard, ...s.sidebarCards],
        rightSidebarOpen: true,
        rightSidebarContent: 'node',
      };
    }),
  addSidebarCards: (nodeIds, cardType) =>
    set((s) => {
      const baseTime = Date.now();
      const newCards: SidebarCard[] = [];
      const existingCards = [...s.sidebarCards];

      nodeIds.forEach((nodeId, index) => {
        const existingIndex = existingCards.findIndex(
          (c) => c.nodeId === nodeId && c.cardType === cardType,
        );
        if (existingIndex >= 0) {
          const existing = existingCards.splice(existingIndex, 1)[0];
          newCards.push({ ...existing, addedAt: baseTime + index });
        } else {
          newCards.push({ id: baseTime + index, nodeId, cardType, addedAt: baseTime + index });
        }
      });

      return {
        sidebarCards: [...newCards, ...existingCards],
        rightSidebarOpen: true,
        rightSidebarContent: 'node',
      };
    }),
  removeSidebarCard: (cardId) =>
    set((s) => {
      const newCards = s.sidebarCards.filter((c) => c.id !== cardId);
      if (newCards.length === 0) {
        return { sidebarCards: newCards, rightSidebarOpen: false, rightSidebarContent: null };
      }
      return { sidebarCards: newCards };
    }),
  clearSidebarCards: () => set({ sidebarCards: [], rightSidebarOpen: false, rightSidebarContent: null }),
  openLocalGraph: (nodeId) =>
    set((s) => {
      const existingIndex = s.sidebarCards.findIndex(
        (c) => c.nodeId === nodeId && c.cardType === 'localGraph',
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
          localGraphNodeId: nodeId,
        };
      }
      const newCard: SidebarCard = {
        id: Date.now(),
        nodeId,
        cardType: 'localGraph',
        addedAt: Date.now(),
      };
      return {
        sidebarCards: [newCard, ...s.sidebarCards],
        rightSidebarOpen: true,
        rightSidebarContent: 'node',
        localGraphNodeId: nodeId,
      };
    }),
  closeLocalGraph: () =>
    set((s) => {
      const newCards = s.sidebarCards.filter((c) => c.cardType !== 'localGraph');
      if (newCards.length === 0) {
        return { sidebarCards: newCards, rightSidebarOpen: false, rightSidebarContent: null, localGraphNodeId: null };
      }
      return { sidebarCards: newCards, localGraphNodeId: null };
    }),
}));
