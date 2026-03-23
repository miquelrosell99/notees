import { create } from 'zustand';
import { type QueryClient } from '@tanstack/react-query';
import * as undoApi from '@/api/undo';
import { nodeKeys, propertyKeys } from '@/hooks/queryKeys';

interface UndoState {
  canUndo: boolean;
  canRedo: boolean;
  refreshStack: (queryClient?: QueryClient) => Promise<void>;
  performUndo: (queryClient: QueryClient) => Promise<void>;
  performRedo: (queryClient: QueryClient) => Promise<void>;
}

export const useUndoStore = create<UndoState>()((set, get) => ({
  canUndo: false,
  canRedo: false,

  refreshStack: async () => {
    try {
      const stack = await undoApi.getUndoStack();
      set({ canUndo: stack.undo_count > 0, canRedo: stack.redo_count > 0 });
    } catch {
      // Ignore errors (e.g. not authenticated)
    }
  },

  performUndo: async (queryClient: QueryClient) => {
    try {
      const result = await undoApi.undo();
      await invalidateForEntity(queryClient, result.entity_type, result.entity_id);
      await get().refreshStack();
    } catch {
      // 404 = nothing to undo
      await get().refreshStack();
    }
  },

  performRedo: async (queryClient: QueryClient) => {
    try {
      const result = await undoApi.redo();
      await invalidateForEntity(queryClient, result.entity_type, result.entity_id);
      await get().refreshStack();
    } catch {
      // 404 = nothing to redo
      await get().refreshStack();
    }
  },
}));

async function invalidateForEntity(queryClient: QueryClient, _entityType: string, entityId: number) {
  // Broad invalidation to ensure UI consistency after undo/redo
  await queryClient.invalidateQueries({ queryKey: nodeKeys.detailBase(entityId) });
  await queryClient.invalidateQueries({ queryKey: nodeKeys.pageContent(entityId) });
  await queryClient.invalidateQueries({ queryKey: nodeKeys.backlinks(entityId) });
  await queryClient.invalidateQueries({ queryKey: nodeKeys.linkedRefs(entityId) });
  await queryClient.invalidateQueries({ queryKey: nodeKeys.lists() });
  await queryClient.invalidateQueries({ queryKey: nodeKeys.classes() });
  await queryClient.invalidateQueries({ queryKey: propertyKeys.all });
}
