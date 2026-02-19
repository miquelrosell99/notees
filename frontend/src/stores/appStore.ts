/**
 * Nodes store using Zustand
 * 
 * Manages the current node state and selection.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Node } from '@/types';
import type { NodeCollectionViewMode } from '@/types/nodeCollection';

export type ViewMode = 'default' | 'focus' | 'zen';
export type MainViewType = 'node' | 'all-pages' | 'journals' | 'graph' | 'terrain' | 'timeline' | 'archived' | 'trash' | 'assets' | 'property';
export type NodeViewType = 'page' | 'block';
export type SidebarTab = 'pages' | 'graph';
export type SidebarNodeType = 'page' | 'block';
export type RightSidebarContent = 'node' | 'localGraph' | 'activity' | null;

/** Display mode for node content: document (prose), bullet (outline), or card (blocks as cards) */
export type ContentDisplayMode = 'document' | 'bullet' | 'card';

/** Card layout when in card display mode */
export type CardLayoutMode = 'no-cover' | 'cover-top' | 'cover-left' | 'cover-right';

/** Card size options - number of columns */
export type CardSizeMode = 1 | 2 | 3 | 4 | 5;

interface SidebarNode {
  id: number;
  type: SidebarNodeType;
}

/** Card content types for the right sidebar */
export type SidebarCardType = 'page' | 'block' | 'localGraph';

/** A card in the right sidebar */
export interface SidebarCard {
  id: number;
  nodeId: number;
  cardType: SidebarCardType;
  addedAt: number; // timestamp for ordering
}

interface NodesState {
  // Currently selected/active node
  activeNode: Node | null;
  activeNodeId: number | null;
  
  // Current node being viewed (can be page or block)
  currentNodeId: number | null;
  
  // Property context for when viewing a block that comes from a text property
  // Used to show property name in breadcrumbs
  currentPropertyContext: { propertyId: number; propertyName: string } | null;
  
  // Sidebar state
  sidebarOpen: boolean;
  rightSidebarOpen: boolean;
  isSidebarCollapsed: boolean;
  sidebarTab: SidebarTab;
  
  // Right sidebar content
  rightSidebarContent: RightSidebarContent;
  sidebarNode: SidebarNode | null;
  sidebarCards: SidebarCard[]; // List of cards in sidebar
  localGraphNodeId: number | null;
  
  // Comments sidebar state
  commentsSidebarOpen: boolean;
  commentsNodeId: number | null;
  
  // View mode
  viewMode: ViewMode;
  
  // Main view type (what's displayed in the main content area)
  mainViewType: MainViewType;
  
  // Current property being viewed (when mainViewType is 'property')
  currentPropertyId: number | null;
  
  // UI state
  isCalendarOpen: boolean;
  isQuickAddOpen: boolean;
  isCommandPaletteOpen: boolean;
  isImportDataModalOpen: boolean;
  isImportLogseqModalOpen: boolean;
  isImportMarkdownModalOpen: boolean;
  isExportPageModalOpen: boolean;
  isRebuildLinksModalOpen: boolean;
  showDbManagement: boolean;
  isMinimapOpen: boolean;
  
  // New features state
  contentDisplayMode: ContentDisplayMode;
  cardLayout: CardLayoutMode;
  cardSize: CardSizeMode;
  isScratchpadOpen: boolean;
  lateNightThoughtsFilter: boolean;
  
  // Per-node view mode storage (persisted)
  nodeViewModes: Record<number, NodeCollectionViewMode>;
  
  // Actions
  setActiveNode: (node: Node | null) => void;
  setActiveNodeId: (id: number | null) => void;
  /** Navigate to a node. The view layer resolves page vs block from is_page. */
  openNode: (nodeId: number, propertyContext?: { propertyId: number; propertyName: string }) => void;
  toggleSidebar: () => void;
  toggleRightSidebar: () => void;
  setViewMode: (mode: ViewMode) => void;
  toggleFocusMode: () => void;
  setMainViewType: (viewType: MainViewType) => void;
  /** Open a property view */
  openPropertyView: (propertyId: number) => void;
  setSidebarTab: (tab: SidebarTab) => void;
  setCalendarOpen: (open: boolean) => void;
  toggleCalendar: () => void;
  setQuickAddOpen: (open: boolean) => void;
  toggleQuickAdd: () => void;
  setCommandPaletteOpen: (open: boolean) => void;
  toggleCommandPalette: () => void;
  setImportDataModalOpen: (open: boolean) => void;
  setImportLogseqModalOpen: (open: boolean) => void;
  setImportMarkdownModalOpen: (open: boolean) => void;
  setExportPageModalOpen: (open: boolean) => void;
  setRebuildLinksModalOpen: (open: boolean) => void;
  openNodeInSidebar: (nodeId: number, nodeType: SidebarNodeType) => void;
  closeSidebarNode: () => void;
  /** Add a card to the sidebar (shift-click behavior) */
  addSidebarCard: (nodeId: number, cardType: SidebarCardType) => void;
  addSidebarCards: (nodeIds: number[], cardType: SidebarCardType) => void;
  /** Remove a specific card from the sidebar */
  removeSidebarCard: (cardId: number) => void;
  /** Clear all sidebar cards */
  clearSidebarCards: () => void;
  /** Open local graph as a sidebar card */
  openLocalGraph: (nodeId: number) => void;
  closeLocalGraph: () => void;
  openCommentsForNode: (nodeId: number) => void;
  closeCommentsSidebar: () => void;
  toggleCommentsSidebar: () => void;
  setShowDbManagement: (show: boolean) => void;
  toggleMinimap: () => void;
  setMinimapOpen: (open: boolean) => void;
  // New feature actions
  toggleContentDisplayMode: () => void;
  setContentDisplayMode: (mode: ContentDisplayMode) => void;
  setCardLayout: (layout: CardLayoutMode) => void;
  setCardSize: (size: CardSizeMode) => void;
  toggleScratchpad: () => void;
  setScratchpadOpen: (open: boolean) => void;
  toggleLateNightThoughts: () => void;
  setLateNightThoughtsFilter: (enabled: boolean) => void;
  
  // Per-node view mode actions
  setNodeViewMode: (nodeId: number, viewType: string, mode: NodeCollectionViewMode) => void;
  getNodeViewMode: (nodeId: number, viewType: string) => NodeCollectionViewMode | undefined;
}

export const useAppStore = create<NodesState>()(persist((set, get) => ({
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
  commentsSidebarOpen: false,
  commentsNodeId: null,
  viewMode: 'default',
  mainViewType: 'node' as MainViewType,
  currentPropertyId: null,
  isCalendarOpen: false,
  isQuickAddOpen: false,
  isCommandPaletteOpen: false,
  isImportDataModalOpen: false,
  isImportLogseqModalOpen: false,
  isImportMarkdownModalOpen: false,
  isExportPageModalOpen: false,
  isRebuildLinksModalOpen: false,
  showDbManagement: false,
  isMinimapOpen: false,
  // New features state
  contentDisplayMode: 'bullet' as ContentDisplayMode,
  cardLayout: 'no-cover' as CardLayoutMode,
  cardSize: 3 as CardSizeMode,
  isScratchpadOpen: false,
  lateNightThoughtsFilter: false,
  nodeViewModes: {},
  
  setActiveNode: (node) => set({ activeNode: node, activeNodeId: node?.id ?? null }),
  setActiveNodeId: (id) => set({ activeNodeId: id }),
  openNode: (nodeId, propertyContext) => set({ 
    currentNodeId: nodeId, 
    currentPropertyContext: propertyContext ?? null,
    mainViewType: 'node' 
  }),
  toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen, isSidebarCollapsed: !state.isSidebarCollapsed })),
  toggleRightSidebar: () => set((state) => ({ rightSidebarOpen: !state.rightSidebarOpen })),
  setViewMode: (mode) => set({ viewMode: mode }),
  toggleFocusMode: () => set((state) => ({ viewMode: state.viewMode === 'focus' ? 'default' : 'focus' })),
  setMainViewType: (viewType) => set({ mainViewType: viewType }),
  openPropertyView: (propertyId) => set({ mainViewType: 'property', currentPropertyId: propertyId }),
  setSidebarTab: (tab) => set({ sidebarTab: tab }),
  setCalendarOpen: (open) => set({ isCalendarOpen: open }),
  toggleCalendar: () => set((state) => ({ isCalendarOpen: !state.isCalendarOpen })),
  setQuickAddOpen: (open) => set({ isQuickAddOpen: open }),
  toggleQuickAdd: () => set((state) => ({ isQuickAddOpen: !state.isQuickAddOpen })),
  setCommandPaletteOpen: (open) => set({ isCommandPaletteOpen: open }),
  toggleCommandPalette: () => set((state) => ({ isCommandPaletteOpen: !state.isCommandPaletteOpen })),
  setImportDataModalOpen: (open) => set({ isImportDataModalOpen: open }),
  setImportLogseqModalOpen: (open) => set({ isImportLogseqModalOpen: open }),
  setImportMarkdownModalOpen: (open) => set({ isImportMarkdownModalOpen: open }),
  setExportPageModalOpen: (open) => set({ isExportPageModalOpen: open }),
  setRebuildLinksModalOpen: (open) => set({ isRebuildLinksModalOpen: open }),
  openNodeInSidebar: (nodeId, nodeType) => set({ 
    rightSidebarOpen: true, 
    rightSidebarContent: 'node',
    sidebarNode: { id: nodeId, type: nodeType },
  }),
  closeSidebarNode: () => set({
    rightSidebarOpen: false,
    rightSidebarContent: null,
    sidebarNode: null,
  }),
  addSidebarCard: (nodeId, cardType) => set((state) => {
    // Check if card already exists for this node with same type
    const existingIndex = state.sidebarCards.findIndex(c => c.nodeId === nodeId && c.cardType === cardType);
    if (existingIndex >= 0) {
      // Move existing card to the top
      const existing = state.sidebarCards[existingIndex];
      const newCards = [
        { ...existing, addedAt: Date.now() },
        ...state.sidebarCards.slice(0, existingIndex),
        ...state.sidebarCards.slice(existingIndex + 1),
      ];
      return { sidebarCards: newCards, rightSidebarOpen: true, rightSidebarContent: 'node' };
    }
    // Add new card at the top
    const newCard: SidebarCard = {
      id: Date.now(),
      nodeId,
      cardType,
      addedAt: Date.now(),
    };
    return { 
      sidebarCards: [newCard, ...state.sidebarCards],
      rightSidebarOpen: true,
      rightSidebarContent: 'node',
    };
  }),
  addSidebarCards: (nodeIds, cardType) => set((state) => {
    const baseTime = Date.now();
    const newCards: SidebarCard[] = [];
    const existingCards = [...state.sidebarCards];
    
    nodeIds.forEach((nodeId, index) => {
      // Check if card already exists
      const existingIndex = existingCards.findIndex(c => c.nodeId === nodeId && c.cardType === cardType);
      if (existingIndex >= 0) {
        // Update timestamp and move to top
        const existing = existingCards.splice(existingIndex, 1)[0];
        newCards.push({ ...existing, addedAt: baseTime + index });
      } else {
        // Create new card
        newCards.push({
          id: baseTime + index,
          nodeId,
          cardType,
          addedAt: baseTime + index,
        });
      }
    });
    
    return {
      sidebarCards: [...newCards, ...existingCards],
      rightSidebarOpen: true,
      rightSidebarContent: 'node',
    };
  }),
  removeSidebarCard: (cardId) => set((state) => {
    const newCards = state.sidebarCards.filter(c => c.id !== cardId);
    // If no cards left, close the sidebar
    if (newCards.length === 0) {
      return { 
        sidebarCards: newCards, 
        rightSidebarOpen: false, 
        rightSidebarContent: null 
      };
    }
    return { sidebarCards: newCards };
  }),
  clearSidebarCards: () => set({
    sidebarCards: [],
    rightSidebarOpen: false,
    rightSidebarContent: null,
  }),
  openLocalGraph: (nodeId) => set((state) => {
    // Check if a local graph card already exists for this node
    const existingIndex = state.sidebarCards.findIndex(c => c.nodeId === nodeId && c.cardType === 'localGraph');
    if (existingIndex >= 0) {
      // Move existing card to the top
      const existing = state.sidebarCards[existingIndex];
      const newCards = [
        { ...existing, addedAt: Date.now() },
        ...state.sidebarCards.slice(0, existingIndex),
        ...state.sidebarCards.slice(existingIndex + 1),
      ];
      return { 
        sidebarCards: newCards, 
        rightSidebarOpen: true, 
        rightSidebarContent: 'node',
        localGraphNodeId: nodeId,
      };
    }
    // Add new local graph card at the top
    const newCard: SidebarCard = {
      id: Date.now(),
      nodeId,
      cardType: 'localGraph',
      addedAt: Date.now(),
    };
    return { 
      sidebarCards: [newCard, ...state.sidebarCards],
      rightSidebarOpen: true,
      rightSidebarContent: 'node',
      localGraphNodeId: nodeId,
    };
  }),
  closeLocalGraph: () => set((state) => {
    // Remove all local graph cards
    const newCards = state.sidebarCards.filter(c => c.cardType !== 'localGraph');
    if (newCards.length === 0) {
      return {
        sidebarCards: newCards,
        rightSidebarOpen: false,
        rightSidebarContent: null,
        localGraphNodeId: null,
      };
    }
    return {
      sidebarCards: newCards,
      localGraphNodeId: null,
    };
  }),
  openCommentsForNode: (nodeId) => set({
    commentsSidebarOpen: true,
    commentsNodeId: nodeId,
  }),
  closeCommentsSidebar: () => set({
    commentsSidebarOpen: false,
    commentsNodeId: null,
  }),
  toggleCommentsSidebar: () => set((state) => ({
    commentsSidebarOpen: !state.commentsSidebarOpen,
  })),
  setShowDbManagement: (show) => set({ showDbManagement: show }),
  toggleMinimap: () => set((state) => ({ isMinimapOpen: !state.isMinimapOpen })),
  setMinimapOpen: (open) => set({ isMinimapOpen: open }),
  // New feature actions
  toggleContentDisplayMode: () => set((state) => ({ 
    contentDisplayMode: state.contentDisplayMode === 'bullet' 
      ? 'document' 
      : state.contentDisplayMode === 'document' 
        ? 'card' 
        : 'bullet' 
  })),
  setContentDisplayMode: (mode) => set({ contentDisplayMode: mode }),
  setCardLayout: (layout) => set({ cardLayout: layout }),
  setCardSize: (size) => set({ cardSize: size }),
  toggleScratchpad: () => set((state) => ({ isScratchpadOpen: !state.isScratchpadOpen })),
  setScratchpadOpen: (open) => set({ isScratchpadOpen: open }),
  toggleLateNightThoughts: () => set((state) => ({ lateNightThoughtsFilter: !state.lateNightThoughtsFilter })),
  setLateNightThoughtsFilter: (enabled) => set({ lateNightThoughtsFilter: enabled }),
  
  // Per-node view mode actions
  setNodeViewMode: (nodeId, viewType, mode) => set((state) => ({
    nodeViewModes: { ...state.nodeViewModes, [`${nodeId}-${viewType}`]: mode }
  })),
  getNodeViewMode: (nodeId, viewType) => get().nodeViewModes[`${nodeId}-${viewType}`],
}), {
  name: 'notees-node-view-modes',
  partialize: (state) => ({ 
    nodeViewModes: state.nodeViewModes,
    cardLayout: state.cardLayout,
    cardSize: state.cardSize,
    contentDisplayMode: state.contentDisplayMode,
  }),
}));
