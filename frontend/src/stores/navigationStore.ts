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

export type SplitOrientation = 'horizontal' | 'vertical';

export interface TabHistoryEntry {
  type: MainViewType;
  nodeUuid?: string;
  propertyUuid?: string;
  label: string;
  icon?: string;
  color?: string;
}

export interface Tab {
  id: string;
  type: MainViewType;
  nodeUuid?: string;
  propertyUuid?: string;
  label: string;
  icon?: string;
  color?: string;
  pinned: boolean;
  history: TabHistoryEntry[];
  historyIndex: number;
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

  // ── Tabs ────────────────────────────────────────────────────────────────
  tabs: Tab[];
  activeTabId: string | null;
  secondaryTabId: string | null;
  splitOrientation: SplitOrientation | null;

  // Actions
  setActiveNodeUuid: (uuid: string | null) => void;
  openNode: (nodeUuid: string, propertyContext?: { propertyUuid: string; propertyName: string }) => void;
  openNodeInNewTab: (nodeUuid: string, opts?: { label?: string; icon?: string; color?: string }) => void;
  openViewInNewTab: (viewType: MainViewType, opts?: { label?: string; nodeUuid?: string; propertyUuid?: string }) => void;
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
  replaceTabContent: (tabId: string, nodeUuid: string, opts?: { label?: string; icon?: string; color?: string }) => void;
  addTabAt: (index: number, tab: Tab) => void;
  goBack: () => boolean;
  goForward: () => boolean;
  canGoBack: () => boolean;
  canGoForward: () => boolean;
  navigateToHistoryEntry: (tabId: string, index: number) => void;
}

export const useNavigationStore = create<NavigationState>()((set, get) => {
  const makeHistoryEntry = (tab: Tab): TabHistoryEntry => ({
    type: tab.type,
    nodeUuid: tab.nodeUuid,
    propertyUuid: tab.propertyUuid,
    label: tab.label,
    icon: tab.icon,
    color: tab.color,
  });

  const pushTabHistory = (tab: Tab, entry: TabHistoryEntry): Tab => {
    // Trim forward history when pushing new entry
    const newHistory = tab.history.slice(0, tab.historyIndex + 1);
    // Avoid duplicate consecutive entries
    const last = newHistory[newHistory.length - 1];
    if (
      last &&
      last.type === entry.type &&
      last.nodeUuid === entry.nodeUuid &&
      last.propertyUuid === entry.propertyUuid
    ) {
      return tab;
    }
    newHistory.push(entry);
    // Cap history at 50 entries
    if (newHistory.length > 50) {
      newHistory.shift();
    }
    return { ...tab, history: newHistory, historyIndex: newHistory.length - 1 };
  };

  return {
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

    // Tabs
    tabs: [],
    activeTabId: null,
    secondaryTabId: null,
    splitOrientation: null,

    setActiveNodeUuid: (uuid) => set({ activeNodeUuid: uuid }),

    openNode: (nodeUuid, propertyContext) => {
      const state = get();

      // If this node is already open in a tab, activate that tab instead of
      // replacing the current one (browser-like tab navigation)
      const existingTab = state.tabs.find((t) => t.nodeUuid === nodeUuid && t.type === 'node');
      if (existingTab) {
        set({
          activeTabId: existingTab.id,
          currentNodeUuid: existingTab.nodeUuid ?? null,
          mainViewType: existingTab.type,
          currentPropertyUuid: existingTab.propertyUuid ?? null,
          currentPropertyContext: propertyContext ?? null,
        });
        return;
      }

      const activeTab = state.tabs.find((t) => t.id === state.activeTabId);
      const isNewNode = activeTab?.nodeUuid !== nodeUuid;
      const newTabId = generateTabId();
      const newTabs = activeTab
        ? state.tabs.map((t) => {
            if (t.id !== state.activeTabId) return t;
            const updated = pushTabHistory(t, makeHistoryEntry(t));
            return {
              ...updated,
              type: 'node' as MainViewType,
              nodeUuid,
              propertyUuid: undefined,
              label: isNewNode ? 'Node' : t.label,
              icon: isNewNode ? undefined : t.icon,
              color: isNewNode ? undefined : t.color,
            };
          })
        : [...state.tabs, { id: newTabId, type: 'node' as MainViewType, nodeUuid, label: 'Node', pinned: false, history: [], historyIndex: -1 }];
      set({
        tabs: newTabs,
        activeTabId: activeTab ? state.activeTabId : newTabId,
        currentNodeUuid: nodeUuid,
        currentPropertyContext: propertyContext ?? null,
        mainViewType: 'node',
        currentPropertyUuid: null,
      });
    },

    openNodeInNewTab: (nodeUuid, opts) => {
      const state = get();
      const newTab: Tab = {
        id: generateTabId(),
        type: 'node',
        nodeUuid,
        label: opts?.label || 'Node',
        icon: opts?.icon,
        color: opts?.color,
        pinned: false,
        history: [],
        historyIndex: -1,
      };
      // Insert after active tab
      const activeIdx = state.tabs.findIndex((t) => t.id === state.activeTabId);
      const insertIdx = activeIdx >= 0 ? activeIdx + 1 : state.tabs.length;
      const newTabs = [...state.tabs.slice(0, insertIdx), newTab, ...state.tabs.slice(insertIdx)];
      set({ tabs: newTabs, activeTabId: newTab.id, currentNodeUuid: nodeUuid, mainViewType: 'node', currentPropertyUuid: null });
    },

    openViewInNewTab: (viewType, opts) => {
      const state = get();
      const nodeUuid = opts?.nodeUuid;
      const newTab: Tab = {
        id: generateTabId(),
        type: viewType,
        nodeUuid,
        propertyUuid: opts?.propertyUuid,
        label: opts?.label || makeTabLabel(viewType),
        pinned: false,
        history: [],
        historyIndex: -1,
      };
      const activeIdx = state.tabs.findIndex((t) => t.id === state.activeTabId);
      const insertIdx = activeIdx >= 0 ? activeIdx + 1 : state.tabs.length;
      const newTabs = [...state.tabs.slice(0, insertIdx), newTab, ...state.tabs.slice(insertIdx)];
      set({
        tabs: newTabs,
        activeTabId: newTab.id,
        mainViewType: viewType,
        currentNodeUuid: nodeUuid ?? null,
        currentPropertyUuid: opts?.propertyUuid ?? null,
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

    setSwitchingWorkspace: (value) => set({ isSwitchingWorkspace: value }),

    setMainViewType: (viewType) => {
      const state = get();
      const activeTab = state.tabs.find((t) => t.id === state.activeTabId);
      const newTabs = activeTab
        ? state.tabs.map((t) => {
            if (t.id !== state.activeTabId) return t;
            const updated = pushTabHistory(t, makeHistoryEntry(t));
            return { ...updated, type: viewType, nodeUuid: undefined, propertyUuid: undefined, icon: undefined, color: undefined, label: makeTabLabel(viewType) };
          })
        : [...state.tabs, { id: generateTabId(), type: viewType, label: makeTabLabel(viewType), pinned: false, history: [], historyIndex: -1 }];
      set({ tabs: newTabs, mainViewType: viewType, currentNodeUuid: null, currentPropertyUuid: null });
    },

    openPropertyView: (propertyUuid) => {
      if (!propertyUuid) return;
      const state = get();
      const activeTab = state.tabs.find((t) => t.id === state.activeTabId);
      const newTabs = activeTab
        ? state.tabs.map((t) => {
            if (t.id !== state.activeTabId) return t;
            const updated = pushTabHistory(t, makeHistoryEntry(t));
            return { ...updated, type: 'property' as MainViewType, propertyUuid, nodeUuid: undefined, icon: undefined, color: undefined, label: 'Property' };
          })
        : [
            ...state.tabs,
            { id: generateTabId(), type: 'property' as MainViewType, propertyUuid, label: 'Property', pinned: false, history: [], historyIndex: -1 },
          ];
      set({ tabs: newTabs, mainViewType: 'property', currentPropertyUuid: propertyUuid, currentNodeUuid: null });
    },

    openNodeCollection: (title, queryAST) => {
      const state = get();
      const activeTab = state.tabs.find((t) => t.id === state.activeTabId);
      const newTabs = activeTab
        ? state.tabs.map((t) => {
            if (t.id !== state.activeTabId) return t;
            const updated = pushTabHistory(t, makeHistoryEntry(t));
            return { ...updated, type: 'node-collection' as MainViewType, nodeUuid: undefined, propertyUuid: undefined, icon: undefined, color: undefined, label: title };
          })
        : [...state.tabs, { id: generateTabId(), type: 'node-collection' as MainViewType, label: title, pinned: false, history: [], historyIndex: -1 }];
      set({ tabs: newTabs, mainViewType: 'node-collection', nodeCollectionTitle: title, nodeCollectionQueryAST: queryAST, nodeCollectionNodeUuids: null, currentNodeUuid: null, currentPropertyUuid: null });
    },
    openNodeCollectionFromNodes: (title, nodeUuids) => {
      const state = get();
      const activeTab = state.tabs.find((t) => t.id === state.activeTabId);
      const newTabs = activeTab
        ? state.tabs.map((t) => {
            if (t.id !== state.activeTabId) return t;
            const updated = pushTabHistory(t, makeHistoryEntry(t));
            return { ...updated, type: 'node-collection' as MainViewType, nodeUuid: undefined, propertyUuid: undefined, icon: undefined, color: undefined, label: title };
          })
        : [...state.tabs, { id: generateTabId(), type: 'node-collection' as MainViewType, label: title, pinned: false, history: [], historyIndex: -1 }];
      set({ tabs: newTabs, mainViewType: 'node-collection', nodeCollectionTitle: title, nodeCollectionQueryAST: null, nodeCollectionNodeUuids: nodeUuids, currentNodeUuid: null, currentPropertyUuid: null });
    },
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
      setTimeout(() => {
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

    // ── Tab actions ───────────────────────────────────────────────────────
    activateTab: (tabId) => {
      const state = get();
      const tab = state.tabs.find((t) => t.id === tabId);
      if (!tab) return;
      set({
        activeTabId: tabId,
        currentNodeUuid: tab.nodeUuid ?? null,
        mainViewType: tab.type,
        currentPropertyUuid: tab.propertyUuid ?? null,
      });
    },

    closeTab: (tabId) => {
      const state = get();
      const idx = state.tabs.findIndex((t) => t.id === tabId);
      const newTabs = state.tabs.filter((t) => t.id !== tabId);
      let newActiveId = state.activeTabId;
      let newSecondaryId = state.secondaryTabId;

      if (state.activeTabId === tabId) {
        // Activate previous tab (or next if at start)
        newActiveId = newTabs[Math.max(0, idx - 1)]?.id ?? null;
      }
      if (state.secondaryTabId === tabId) {
        newSecondaryId = null;
      }

      const activeTab = newActiveId ? newTabs.find((t) => t.id === newActiveId) : null;
      set({
        tabs: newTabs,
        activeTabId: newActiveId,
        secondaryTabId: newSecondaryId,
        splitOrientation: newSecondaryId ? state.splitOrientation : null,
        currentNodeUuid: activeTab?.nodeUuid ?? null,
        mainViewType: activeTab?.type ?? 'node',
        currentPropertyUuid: activeTab?.propertyUuid ?? null,
      });
    },

    closeOtherTabs: (tabId) => {
      const state = get();
      const keep = state.tabs.filter((t) => t.id === tabId || t.pinned);
      const activeTab = keep.find((t) => t.id === tabId);
      set({
        tabs: keep,
        activeTabId: keep.length > 0 ? tabId : null,
        secondaryTabId: null,
        splitOrientation: null,
        currentNodeUuid: activeTab?.nodeUuid ?? null,
        mainViewType: activeTab?.type ?? 'node',
        currentPropertyUuid: activeTab?.propertyUuid ?? null,
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
        if (!fallback) {
          // All tabs were removed
          set({
            tabs: [],
            activeTabId: null,
            secondaryTabId: null,
            splitOrientation: null,
            currentNodeUuid: null,
            mainViewType: 'node',
            currentPropertyUuid: null,
          });
          return;
        }
        set({
          tabs: newTabs,
          activeTabId: fallback.id,
          secondaryTabId: newSecondaryId,
          splitOrientation: newSecondaryId ? state.splitOrientation : null,
          currentNodeUuid: fallback.nodeUuid ?? null,
          mainViewType: fallback.type,
          currentPropertyUuid: fallback.propertyUuid ?? null,
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

    replaceTabContent: (tabId, nodeUuid, opts) => {
      set((s) => {
        const tab = s.tabs.find((t) => t.id === tabId);
        if (!tab) return s;
        const updated = pushTabHistory(tab, makeHistoryEntry(tab));
        const newTab: Tab = {
          ...updated,
          type: 'node',
          nodeUuid,
          propertyUuid: undefined,
          label: opts?.label || tab.label,
          icon: opts?.icon ?? tab.icon,
          color: opts?.color ?? tab.color,
        };
        const newTabs = s.tabs.map((t) => (t.id === tabId ? newTab : t));
        const patch: Partial<NavigationState> = { tabs: newTabs };
        if (s.activeTabId === tabId) {
          patch.currentNodeUuid = nodeUuid;
          patch.mainViewType = 'node';
          patch.currentPropertyUuid = null;
        }
        return patch;
      });
    },

    goBack: () => {
      const state = get();
      const activeTab = state.tabs.find((t) => t.id === state.activeTabId);
      if (!activeTab || activeTab.historyIndex <= 0) return false;
      const newIndex = activeTab.historyIndex - 1;
      const entry = activeTab.history[newIndex];
      const newTab = { ...activeTab, historyIndex: newIndex, ...entry };
      const newTabs = state.tabs.map((t) => (t.id === activeTab.id ? newTab : t));
      set({
        tabs: newTabs,
        currentNodeUuid: entry.nodeUuid ?? null,
        mainViewType: entry.type,
        currentPropertyUuid: entry.propertyUuid ?? null,
      });
      return true;
    },

    goForward: () => {
      const state = get();
      const activeTab = state.tabs.find((t) => t.id === state.activeTabId);
      if (!activeTab || activeTab.historyIndex >= activeTab.history.length - 1) return false;
      const newIndex = activeTab.historyIndex + 1;
      const entry = activeTab.history[newIndex];
      const newTab = { ...activeTab, historyIndex: newIndex, ...entry };
      const newTabs = state.tabs.map((t) => (t.id === activeTab.id ? newTab : t));
      set({
        tabs: newTabs,
        currentNodeUuid: entry.nodeUuid ?? null,
        mainViewType: entry.type,
        currentPropertyUuid: entry.propertyUuid ?? null,
      });
      return true;
    },

    canGoBack: () => {
      const state = get();
      const activeTab = state.tabs.find((t) => t.id === state.activeTabId);
      return !!activeTab && activeTab.historyIndex > 0;
    },

    canGoForward: () => {
      const state = get();
      const activeTab = state.tabs.find((t) => t.id === state.activeTabId);
      return !!activeTab && activeTab.historyIndex < activeTab.history.length - 1;
    },

    navigateToHistoryEntry: (tabId, index) => {
      const state = get();
      const tab = state.tabs.find((t) => t.id === tabId);
      if (!tab || index < 0 || index >= tab.history.length) return;
      const entry = tab.history[index];
      const newTab = { ...tab, historyIndex: index, ...entry };
      const newTabs = state.tabs.map((t) => (t.id === tabId ? newTab : t));
      const patch: Partial<NavigationState> = { tabs: newTabs };
      if (state.activeTabId === tabId) {
        patch.currentNodeUuid = entry.nodeUuid ?? null;
        patch.mainViewType = entry.type;
        patch.currentPropertyUuid = entry.propertyUuid ?? null;
      }
      set(patch);
    },

    addTabAt: (index, tab) => {
      set((s) => {
        const newTabs = [...s.tabs.slice(0, index), tab, ...s.tabs.slice(index)];
        return { tabs: newTabs, activeTabId: tab.id };
      });
    },
  };
});
