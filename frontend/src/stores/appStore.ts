/**
 * App store — persisted display preferences (card layout, gantt settings, etc.)
 *
 * Navigation state lives in navigationStore.ts.
 * Modal/overlay flags live in modalStore.ts.
 *
 * Type aliases for navigation and sidebar types are defined here so that
 * all three stores can share them without circular imports, and so that
 * external consumers' existing imports (from '@/stores') continue to work
 * without changes.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { NodeCollectionViewMode } from '@/types/nodeCollection';
import { SYSTEM_PROPERTY_UUIDS } from '@/constants/systemProperties';

// ── Shared type aliases (used by navigationStore + external consumers) ──────────
export type ViewMode = 'default' | 'focus' | 'zen';
export type MainViewType =
  | 'node'
  | 'all-pages'
  | 'journals'
  | 'graph'
  | 'timeline'
  | 'archived'
  | 'trash'
  | 'assets'
  | 'property'
  | 'node-collection'
  | 'shares'
  | 'inbox';
export type NodeViewType = 'page' | 'block';
export type SidebarTab = 'pages' | 'graph';
export type SidebarNodeType = 'page' | 'block';
export type RightSidebarContent = 'node' | 'localGraph' | 'activity' | null;
export type SidebarCardType = 'page' | 'block' | 'localGraph';
export interface SidebarCard {
  id: number;
  nodeId: number;
  cardType: SidebarCardType;
  addedAt: number;
}

// ── Display preference types ──────────────────────────────────────────────────
/** Display mode for node content: document (prose), bullet (outline), or card */
export type ContentDisplayMode = 'document' | 'bullet' | 'card';
/** Card layout when in card display mode */
export type CardLayoutMode = 'no-cover' | 'cover-top' | 'cover-left' | 'cover-right';

interface DisplayPrefsState {
  contentDisplayMode: ContentDisplayMode;
  cardLayout: CardLayoutMode;
  nodeViewModes: Record<string, NodeCollectionViewMode>;
  nodeGroupBy: Record<string, string>;
  ganttStartDatePropertyUuid: string;
  ganttEndDatePropertyUuid: string;
  ganttTimeScale: 'day' | 'week' | 'month';

  toggleContentDisplayMode: () => void;
  setContentDisplayMode: (mode: ContentDisplayMode) => void;
  setCardLayout: (layout: CardLayoutMode) => void;
  setNodeViewMode: (nodeId: number, viewType: string, mode: NodeCollectionViewMode) => void;
  getNodeViewMode: (nodeId: number, viewType: string) => NodeCollectionViewMode | undefined;
  setNodeGroupBy: (nodeId: number, viewType: string, groupBy: string) => void;
  getNodeGroupBy: (nodeId: number, viewType: string) => string | undefined;
  setGanttStartDatePropertyUuid: (uuid: string) => void;
  setGanttEndDatePropertyUuid: (uuid: string) => void;
  setGanttTimeScale: (scale: 'day' | 'week' | 'month') => void;
}

export const useAppStore = create<DisplayPrefsState>()(
  persist(
    (set, get) => ({
      contentDisplayMode: 'bullet' as ContentDisplayMode,
      cardLayout: 'no-cover' as CardLayoutMode,
      nodeViewModes: {},
      nodeGroupBy: {},
      ganttStartDatePropertyUuid: SYSTEM_PROPERTY_UUIDS.task_scheduled,
      ganttEndDatePropertyUuid: SYSTEM_PROPERTY_UUIDS.task_deadline,
      ganttTimeScale: 'week' as 'day' | 'week' | 'month',

      toggleContentDisplayMode: () =>
        set((s) => ({
          contentDisplayMode:
            s.contentDisplayMode === 'bullet'
              ? 'document'
              : s.contentDisplayMode === 'document'
                ? 'card'
                : 'bullet',
        })),
      setContentDisplayMode: (mode) => set({ contentDisplayMode: mode }),
      setCardLayout: (layout) => set({ cardLayout: layout }),

      setNodeViewMode: (nodeId, viewType, mode) =>
        set((s) => ({ nodeViewModes: { ...s.nodeViewModes, [`${nodeId}-${viewType}`]: mode } })),
      getNodeViewMode: (nodeId, viewType) => get().nodeViewModes[`${nodeId}-${viewType}`],

      setNodeGroupBy: (nodeId, viewType, groupBy) =>
        set((s) => ({ nodeGroupBy: { ...s.nodeGroupBy, [`${nodeId}-${viewType}`]: groupBy } })),
      getNodeGroupBy: (nodeId, viewType) => get().nodeGroupBy[`${nodeId}-${viewType}`],

      setGanttStartDatePropertyUuid: (uuid) => set({ ganttStartDatePropertyUuid: uuid }),
      setGanttEndDatePropertyUuid: (uuid) => set({ ganttEndDatePropertyUuid: uuid }),
      setGanttTimeScale: (scale) => set({ ganttTimeScale: scale }),
    }),
    {
      name: 'notees-node-view-modes',
      partialize: (state) => ({
        nodeViewModes: state.nodeViewModes,
        nodeGroupBy: state.nodeGroupBy,
        cardLayout: state.cardLayout,
        contentDisplayMode: state.contentDisplayMode,
        ganttStartDatePropertyUuid: state.ganttStartDatePropertyUuid,
        ganttEndDatePropertyUuid: state.ganttEndDatePropertyUuid,
        ganttTimeScale: state.ganttTimeScale,
      }),
    },
  ),
);
