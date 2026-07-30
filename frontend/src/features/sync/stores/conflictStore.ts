/**
 * conflictStore — unresolved v2 sync conflicts.
 *
 * Holds the three-way diff inputs for each stale node so the UI can present
 * base / ours / theirs and let the user pick a resolution.
 */

import { create } from 'zustand';
import type { Node } from '@/types/api';

export type ConflictType =
  | 'text_edit'
  | 'tree_conflict'
  | 'node_deleted'
  | 'permission_denied'
  | 'class_conflict'
  | 'property_conflict';

export interface SyncConflict {
  workspaceUuid: string;
  nodeUuid: string;
  conflictType: ConflictType;
  /** Server state at the acked vector (common ancestor). */
  baseNode: Node | null;
  /** Local projected state including pending operations. */
  ourNode: Node | null;
  /** Current server state after refetch. */
  theirNode: Node | null;
  /** Local operation IDs involved in this conflict. */
  operationIds: string[];
  createdAt: number;
}

interface ConflictState {
  conflicts: Map<string, SyncConflict>;
  getKey: (workspaceUuid: string, nodeUuid: string) => string;
  addConflict: (conflict: SyncConflict) => void;
  resolveConflict: (workspaceUuid: string, nodeUuid: string) => void;
  clearWorkspace: (workspaceUuid: string) => void;
  getConflictsForWorkspace: (workspaceUuid: string) => SyncConflict[];
}

export const useConflictStore = create<ConflictState>((set, get) => ({
  conflicts: new Map(),

  getKey: (workspaceUuid, nodeUuid) => `${workspaceUuid}:${nodeUuid}`,

  addConflict: (conflict) => {
    const key = get().getKey(conflict.workspaceUuid, conflict.nodeUuid);
    set((state) => {
      const next = new Map(state.conflicts);
      next.set(key, conflict);
      return { conflicts: next };
    });
  },

  resolveConflict: (workspaceUuid, nodeUuid) => {
    const key = get().getKey(workspaceUuid, nodeUuid);
    set((state) => {
      if (!state.conflicts.has(key)) return state;
      const next = new Map(state.conflicts);
      next.delete(key);
      return { conflicts: next };
    });
  },

  clearWorkspace: (workspaceUuid) => {
    set((state) => {
      const next = new Map();
      for (const [key, conflict] of state.conflicts) {
        if (conflict.workspaceUuid !== workspaceUuid) {
          next.set(key, conflict);
        }
      }
      return { conflicts: next };
    });
  },

  getConflictsForWorkspace: (workspaceUuid) => {
    const result: SyncConflict[] = [];
    for (const conflict of get().conflicts.values()) {
      if (conflict.workspaceUuid === workspaceUuid) {
        result.push(conflict);
      }
    }
    return result;
  },
}));
