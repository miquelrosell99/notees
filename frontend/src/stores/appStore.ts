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
import { SYSTEM_PROPERTY_UUIDS } from '@/constants/systemProperties';
import type { NodeCollectionGroupBy } from '@/types/nodeCollection';

// ── Shared type aliases (used by navigationStore + external consumers) ──────────
export type ViewMode = 'default' | 'focus' | 'zen';
export type MainViewType =
  | 'node'
  | 'pages'
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
  | 'inbox'
  | 'whiteboards'
  | 'tasks'
  | 'templates'
  | 'flashcards'
  | string;
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
/** Display mode for node content: document (prose), bullet (outline), or kanban */
export type ContentDisplayMode = 'document' | 'bullet' | 'kanban';
/** Card layout when in card display mode */
export type CardLayoutMode = 'no-cover' | 'cover-top' | 'cover-left' | 'cover-right';

interface DisplayPrefsState {
  contentDisplayMode: ContentDisplayMode;
  cardLayout: CardLayoutMode;
  nodeGroupBy: Record<string, NodeCollectionGroupBy>;
  ganttStartDatePropertyUuid: string;
  ganttEndDatePropertyUuid: string;
  ganttTimeScale: 'day' | 'week' | 'month';

  toggleContentDisplayMode: () => void;
  setContentDisplayMode: (mode: ContentDisplayMode) => void;
  setCardLayout: (layout: CardLayoutMode) => void;
  setNodeGroupBy: (nodeId: number, viewType: string, groupBy: NodeCollectionGroupBy) => void;
  getNodeGroupBy: (nodeId: number, viewType: string) => NodeCollectionGroupBy | undefined;
  setGanttStartDatePropertyUuid: (uuid: string) => void;
  setGanttEndDatePropertyUuid: (uuid: string) => void;
  setGanttTimeScale: (scale: 'day' | 'week' | 'month') => void;
}

export const useAppStore = create<DisplayPrefsState>()(
  persist(
    (set, get) => ({
      contentDisplayMode: 'bullet' as ContentDisplayMode,
      cardLayout: 'no-cover' as CardLayoutMode,
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
                ? 'kanban'
                : 'bullet',
        })),
      setContentDisplayMode: (mode) => set({ contentDisplayMode: mode }),
      setCardLayout: (layout) => set({ cardLayout: layout }),

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
