/**
 * Navigation store — manages app navigation state, sidebar layout, and tabs.
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
import type { QueryAST } from '@/types/queryAST';

interface SidebarNode {
  id: number;
  type: SidebarNodeType;
}

export type SplitOrientation = 'horizontal' | 'vertical';

export interface Tab {
  id: string;
  type: MainViewType;
  nodeId?: number;
  propertyId?: number;
  label: string;
  icon?: string;
  color?: string;
  pinned: boolean;
}

function generateTabId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function makeTabLabel(type: MainViewType, label?: string): string {
  if (label) return label;
  const labels: Record<string, string> = {
    node: 'Node',
    pages: 'Pages',
    'all-pages': 'All Pages',
    journals: 'Journals',
    graph: 'Graph',
    timeline: 'Timeline',
    archived: 'Archived',
    trash: 'Trash',
    assets: 'Assets',
    property: 'Property',
    'node-collection': 'Collection',
    shares: 'Shares',
    inbox: 'Inbox',
    whiteboards: 'Whiteboards',
    tasks: 'Tasks',
  };
  return labels[type] || 'Notees';
}

interface NavigationState {
  // Active / current node (legacy, synced from active tab)
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
  flashSidebarCardId: number | null;

  // View / layout
  viewMode: ViewMode;
  /** Sidebar collapsed state captured on focus-mode entry, restored on exit */
  preFocusModeSidebarCollapsed: boolean | null;
  mainViewType: MainViewType;
  currentPropertyId: number | null;

  // Temporary node collection view
  nodeCollectionTitle: string | null;
  nodeCollectionQueryAST: QueryAST | null;
  nodeCollectionNodes: Node[] | null;

  // ── Tabs ────────────────────────────────────────────────────────────────
  tabs: Tab[];
  activeTabId: string;
  secondaryTabId: string | null;
  splitOrientation: SplitOrientation | null;

  // Actions
  setActiveNode: (node: Node | null) => void;
  setActiveNodeId: (id: number | null) => void;
  openNode: (nodeId: number, propertyContext?: { propertyId: number; propertyName: string }) => void;
  openNodeInNewTab: (nodeId: number, opts?: { label?: string; icon?: string; color?: string }) => void;
  openViewInNewTab: (viewType: MainViewType, opts?: { label?: string; nodeId?: number; propertyId?: number }) => void;
  toggleSidebar: () => void;
  toggleRightSidebar: () => void;
  setViewMode: (mode: ViewMode) => void;
  toggleFocusMode: () => void;
  setMainViewType: (viewType: MainViewType) => void;
  openPropertyView: (propertyId: number) => void;
  openNodeCollection: (title: string, queryAST: QueryAST) => void;
  openNodeCollectionFromNodes: (title: string, nodes: Node[]) => void;
  closeNodeCollection: () => void;
  setSidebarTab: (tab: SidebarTab) => void;
  openNodeInSidebar: (nodeId: number, nodeType: SidebarNodeType) => void;
  closeSidebarNode: () => void;
  addSidebarCard: (nodeId: number, cardType: SidebarCardType) => void;
  addSidebarCards: (nodeIds: number[], cardType: SidebarCardType) => void;
  removeSidebarCard: (cardId: number) => void;
  clearSidebarCards: () => void;
  flashSidebarCard: (cardId: number) => void;
  openLocalGraph: (nodeId: number) => void;
  closeLocalGraph: () => void;

  // Tab actions
  activateTab: (tabId: string) => void;
  closeTab: (tabId: string) => void;
  closeOtherTabs: (tabId: string) => void;
  closeTabsToRight: (tabId: string) => void;
  pinTab: (tabId: string) => void;
  unpinTab: (tabId: string) => void;
  reorderTabs: (fromIndex: number, toIndex: number) => void;
  updateTabLabel: (tabId: string, label: string, icon?: string, color?: string) => void;
  splitTab: (tabId: string, orientation: SplitOrientation) => void;
  unsplit: () => void;
  swapSplit: () => void;
  replaceTabContent: (tabId: string, nodeId: number, opts?: { label?: string; icon?: string; color?: string }) => void;
  addTabAt: (index: number, tab: Tab) => void;
}

export const useNavigationStore = create<NavigationState>()((set, get) => {
  const initialTab: Tab = {
    id: generateTabId(),
    type: 'node',
    label: 'Notees',
    pinned: false,
  };

  return {
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
    flashSidebarCardId: null,
    viewMode: 'default',
    preFocusModeSidebarCollapsed: null,
    mainViewType: 'node' as MainViewType,
    currentPropertyId: null,
    nodeCollectionTitle: null,
    nodeCollectionQueryAST: null,
    nodeCollectionNodes: null,

    // Tabs
    tabs: [initialTab],
    activeTabId: initialTab.id,
    secondaryTabId: null,
    splitOrientation: null,

    setActiveNode: (node) => set({ activeNode: node, activeNodeId: node?.id ?? null }),
    setActiveNodeId: (id) => set({ activeNodeId: id }),

    openNode: (nodeId, propertyContext) => {
      const state = get();
      const activeTab = state.tabs.find((t) => t.id === state.activeTabId);
      const isNewNode = activeTab?.nodeId !== nodeId;
      const newTabs = activeTab
        ? state.tabs.map((t) =>
            t.id === state.activeTabId
              ? {
                  ...t,
                  type: 'node' as MainViewType,
                  nodeId,
                  propertyId: undefined,
                  label: isNewNode ? 'Node' : t.label,
                  icon: isNewNode ? undefined : t.icon,
                  color: isNewNode ? undefined : t.color,
                }
              : t,
          )
        : [...state.tabs, { id: generateTabId(), type: 'node' as MainViewType, nodeId, label: 'Node', pinned: false }];
      set({
        tabs: newTabs,
        currentNodeId: nodeId,
        currentPropertyContext: propertyContext ?? null,
        mainViewType: 'node',
        currentPropertyId: null,
      });
    },

    openNodeInNewTab: (nodeId, opts) => {
      const state = get();
      const newTab: Tab = {
        id: generateTabId(),
        type: 'node',
        nodeId,
        label: opts?.label || 'Node',
        icon: opts?.icon,
        color: opts?.color,
        pinned: false,
      };
      // Insert after active tab
      const activeIdx = state.tabs.findIndex((t) => t.id === state.activeTabId);
      const insertIdx = activeIdx >= 0 ? activeIdx + 1 : state.tabs.length;
      const newTabs = [...state.tabs.slice(0, insertIdx), newTab, ...state.tabs.slice(insertIdx)];
      set({ tabs: newTabs, activeTabId: newTab.id, currentNodeId: nodeId, mainViewType: 'node', currentPropertyId: null });
    },

    openViewInNewTab: (viewType, opts) => {
      const state = get();
      const newTab: Tab = {
        id: generateTabId(),
        type: viewType,
        nodeId: opts?.nodeId,
        propertyId: opts?.propertyId,
        label: opts?.label || makeTabLabel(viewType),
        pinned: false,
      };
      const activeIdx = state.tabs.findIndex((t) => t.id === state.activeTabId);
      const insertIdx = activeIdx >= 0 ? activeIdx + 1 : state.tabs.length;
      const newTabs = [...state.tabs.slice(0, insertIdx), newTab, ...state.tabs.slice(insertIdx)];
      set({
        tabs: newTabs,
        activeTabId: newTab.id,
        mainViewType: viewType,
        currentNodeId: opts?.nodeId ?? null,
        currentPropertyId: opts?.propertyId ?? null,
      });
    },

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

    setMainViewType: (viewType) => {
      const state = get();
      const activeTab = state.tabs.find((t) => t.id === state.activeTabId);
      const newTabs = activeTab
        ? state.tabs.map((t) =>
            t.id === state.activeTabId
              ? { ...t, type: viewType, nodeId: undefined, propertyId: undefined, icon: undefined, color: undefined, label: makeTabLabel(viewType) }
              : t,
          )
        : [...state.tabs, { id: generateTabId(), type: viewType, label: makeTabLabel(viewType), pinned: false }];
      set({ tabs: newTabs, mainViewType: viewType, currentNodeId: null, currentPropertyId: null });
    },

    openPropertyView: (propertyId) => {
      const state = get();
      const activeTab = state.tabs.find((t) => t.id === state.activeTabId);
      const newTabs = activeTab
        ? state.tabs.map((t) =>
            t.id === state.activeTabId
              ? { ...t, type: 'property' as MainViewType, propertyId, nodeId: undefined, icon: undefined, color: undefined, label: 'Property' }
              : t,
          )
        : [
            ...state.tabs,
            { id: generateTabId(), type: 'property' as MainViewType, propertyId, label: 'Property', pinned: false },
          ];
      set({ tabs: newTabs, mainViewType: 'property', currentPropertyId: propertyId, currentNodeId: null });
    },

    openNodeCollection: (title, queryAST) => {
      const state = get();
      const activeTab = state.tabs.find((t) => t.id === state.activeTabId);
      const newTabs = activeTab
        ? state.tabs.map((t) =>
            t.id === state.activeTabId
              ? { ...t, type: 'node-collection' as MainViewType, nodeId: undefined, propertyId: undefined, icon: undefined, color: undefined, label: title }
              : t,
          )
        : [...state.tabs, { id: generateTabId(), type: 'node-collection' as MainViewType, label: title, pinned: false }];
      set({ tabs: newTabs, mainViewType: 'node-collection', nodeCollectionTitle: title, nodeCollectionQueryAST: queryAST, nodeCollectionNodes: null, currentNodeId: null, currentPropertyId: null });
    },
    openNodeCollectionFromNodes: (title, nodes) => {
      const state = get();
      const activeTab = state.tabs.find((t) => t.id === state.activeTabId);
      const newTabs = activeTab
        ? state.tabs.map((t) =>
            t.id === state.activeTabId
              ? { ...t, type: 'node-collection' as MainViewType, nodeId: undefined, propertyId: undefined, icon: undefined, color: undefined, label: title }
              : t,
          )
        : [...state.tabs, { id: generateTabId(), type: 'node-collection' as MainViewType, label: title, pinned: false }];
      set({ tabs: newTabs, mainViewType: 'node-collection', nodeCollectionTitle: title, nodeCollectionQueryAST: null, nodeCollectionNodes: nodes, currentNodeId: null, currentPropertyId: null });
    },
    closeNodeCollection: () =>
      set({ mainViewType: 'node', nodeCollectionTitle: null, nodeCollectionQueryAST: null, nodeCollectionNodes: null }),
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
    flashSidebarCard: (cardId) => {
      set({ flashSidebarCardId: cardId, rightSidebarOpen: true, rightSidebarContent: 'node' });
      setTimeout(() => {
        set({ flashSidebarCardId: null });
      }, 1500);
    },
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

    // ── Tab actions ───────────────────────────────────────────────────────
    activateTab: (tabId) => {
      const state = get();
      const tab = state.tabs.find((t) => t.id === tabId);
      if (!tab) return;
      set({
        activeTabId: tabId,
        currentNodeId: tab.nodeId ?? null,
        mainViewType: tab.type,
        currentPropertyId: tab.propertyId ?? null,
      });
    },

    closeTab: (tabId) => {
      const state = get();
      if (state.tabs.length <= 1) {
        // Don't close the last tab — reset it to home
        const homeTab: Tab = { id: generateTabId(), type: 'node', label: 'Notees', pinned: false };
        set({ tabs: [homeTab], activeTabId: homeTab.id, secondaryTabId: null, splitOrientation: null });
        return;
      }
      const idx = state.tabs.findIndex((t) => t.id === tabId);
      const newTabs = state.tabs.filter((t) => t.id !== tabId);
      let newActiveId = state.activeTabId;
      let newSecondaryId = state.secondaryTabId;

      if (state.activeTabId === tabId) {
        // Activate previous tab (or next if at start)
        newActiveId = newTabs[Math.max(0, idx - 1)]?.id ?? newTabs[0]?.id;
      }
      if (state.secondaryTabId === tabId) {
        newSecondaryId = null;
      }

      const activeTab = newTabs.find((t) => t.id === newActiveId);
      set({
        tabs: newTabs,
        activeTabId: newActiveId,
        secondaryTabId: newSecondaryId,
        splitOrientation: newSecondaryId ? state.splitOrientation : null,
        currentNodeId: activeTab?.nodeId ?? null,
        mainViewType: activeTab?.type ?? 'node',
        currentPropertyId: activeTab?.propertyId ?? null,
      });
    },

    closeOtherTabs: (tabId) => {
      const state = get();
      const keep = state.tabs.filter((t) => t.id === tabId || t.pinned);
      if (keep.length === 0) {
        const homeTab: Tab = { id: generateTabId(), type: 'node', label: 'Notees', pinned: false };
        set({ tabs: [homeTab], activeTabId: homeTab.id, secondaryTabId: null, splitOrientation: null });
        return;
      }
      const activeTab = keep.find((t) => t.id === tabId);
      set({
        tabs: keep,
        activeTabId: tabId,
        secondaryTabId: null,
        splitOrientation: null,
        currentNodeId: activeTab?.nodeId ?? null,
        mainViewType: activeTab?.type ?? 'node',
        currentPropertyId: activeTab?.propertyId ?? null,
      });
    },

    closeTabsToRight: (tabId) => {
      const state = get();
      const idx = state.tabs.findIndex((t) => t.id === tabId);
      if (idx < 0) return;
      const newTabs = state.tabs.slice(0, idx + 1);
      const removedIds = new Set(state.tabs.slice(idx + 1).map((t) => t.id));
      let newSecondaryId = state.secondaryTabId;
      if (state.secondaryTabId && removedIds.has(state.secondaryTabId)) {
        newSecondaryId = null;
      }
      const activeTab = newTabs.find((t) => t.id === state.activeTabId);
      if (!activeTab) {
        // Active tab was removed, fallback
        const fallback = newTabs[newTabs.length - 1];
        set({
          tabs: newTabs,
          activeTabId: fallback.id,
          secondaryTabId: newSecondaryId,
          splitOrientation: newSecondaryId ? state.splitOrientation : null,
          currentNodeId: fallback.nodeId ?? null,
          mainViewType: fallback.type,
          currentPropertyId: fallback.propertyId ?? null,
        });
      } else {
        set({ tabs: newTabs, secondaryTabId: newSecondaryId, splitOrientation: newSecondaryId ? state.splitOrientation : null });
      }
    },

    pinTab: (tabId) => {
      set((s) => {
        const tab = s.tabs.find((t) => t.id === tabId);
        if (!tab || tab.pinned) return s;
        const others = s.tabs.filter((t) => t.id !== tabId);
        const pinnedCount = others.filter((t) => t.pinned).length;
        const newTabs = [...others.slice(0, pinnedCount), { ...tab, pinned: true }, ...others.slice(pinnedCount)];
        return { tabs: newTabs };
      });
    },

    unpinTab: (tabId) => {
      set((s) => {
        const tab = s.tabs.find((t) => t.id === tabId);
        if (!tab || !tab.pinned) return s;
        const others = s.tabs.filter((t) => t.id !== tabId);
        const pinnedCount = others.filter((t) => t.pinned).length;
        // Place after pinned tabs
        const newTabs = [...others.slice(0, pinnedCount), { ...tab, pinned: false }, ...others.slice(pinnedCount)];
        return { tabs: newTabs };
      });
    },

    reorderTabs: (fromIndex, toIndex) => {
      set((s) => {
        const tabs = [...s.tabs];
        const [moved] = tabs.splice(fromIndex, 1);
        tabs.splice(toIndex, 0, moved);
        return { tabs };
      });
    },

    updateTabLabel: (tabId, label, icon, color) => {
      set((s) => ({
        tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, label, ...(icon !== undefined && { icon }), ...(color !== undefined && { color }) } : t)),
      }));
    },

    splitTab: (tabId, orientation) => {
      set({ secondaryTabId: tabId, splitOrientation: orientation });
    },

    unsplit: () => {
      set({ secondaryTabId: null, splitOrientation: null });
    },

    swapSplit: () => {
      const state = get();
      if (!state.secondaryTabId) return;
      set({ activeTabId: state.secondaryTabId, secondaryTabId: state.activeTabId });
    },

    replaceTabContent: (tabId, nodeId, opts) => {
      set((s) => {
        const tab = s.tabs.find((t) => t.id === tabId);
        if (!tab) return s;
        const newTab: Tab = {
          ...tab,
          type: 'node',
          nodeId,
          propertyId: undefined,
          label: opts?.label || tab.label,
          icon: opts?.icon ?? tab.icon,
          color: opts?.color ?? tab.color,
        };
        const newTabs = s.tabs.map((t) => (t.id === tabId ? newTab : t));
        const patch: Partial<NavigationState> = { tabs: newTabs };
        if (s.activeTabId === tabId) {
          patch.currentNodeId = nodeId;
          patch.mainViewType = 'node';
          patch.currentPropertyId = null;
        }
        return patch;
      });
    },

    addTabAt: (index, tab) => {
      set((s) => {
        const newTabs = [...s.tabs.slice(0, index), tab, ...s.tabs.slice(index)];
        return { tabs: newTabs, activeTabId: tab.id };
      });
    },
  };
});
