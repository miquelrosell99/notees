import { create } from 'zustand';
import { type QueryClient } from '@tanstack/react-query';
import type { SerializableUndoEntry } from '@/core/undo';
import { createUndoManagerClient, type UndoManagerClient } from '@/core/hooks/useUndoManager';
import { getWorkspaceStoreClient } from '@/core/adapters/workspaceStoreClientAdapter';
import type { IWorkspaceStoreClient } from '@/core/worker/workerProtocol';
import { nodeKeys, propertyKeys } from '@/hooks/queryKeys';
import { useNotificationStore } from '@/stores/notificationStore';

export interface UnifiedUndoEntry {
  nodeUuid: string;
  uuid: string;
  operation: string;
  entity_type: string;
  entity_id: string;
  description: string;
  /** Negative IDs indicate local (core) entries. */
  runtimeId?: number;
}

interface UndoState {
  currentWorkspaceId: string | null;
  canUndo: boolean;
  canRedo: boolean;
  undoEntries: UnifiedUndoEntry[];
  redoEntries: UnifiedUndoEntry[];
  /** Bump this to force consumers to re-evaluate runtime state. */
  runtimeVersion: number;
  setWorkspaceId: (workspaceId: string | null) => void;
  refreshStack: () => Promise<void>;
  syncRuntimeState: () => Promise<void>;
  performUndo: (queryClient: QueryClient) => Promise<void>;
  performRedo: (queryClient: QueryClient) => Promise<void>;
  performUndoTo: (queryClient: QueryClient, entry: UnifiedUndoEntry) => Promise<void>;
  performRedoTo: (queryClient: QueryClient, entry: UnifiedUndoEntry) => Promise<void>;
  clearHistory: () => Promise<void>;
}

/** Generate a display label from a core undo entry. */
function entryDescription(entry: SerializableUndoEntry): string {
  return entry.label || 'Edit';
}

/** Build synthetic undo-history rows from the core undo-manager stacks. */
function buildLocalEntries(stack: SerializableUndoEntry[]): UnifiedUndoEntry[] {
  // Assign negative IDs based on display order (top/first = -1, next = -2, …).
  return stack.map((entry, displayIndex) => ({
    nodeUuid: '',
    uuid: '',
    operation: 'edit',
    entity_type: 'node',
    entity_id: '',
    description: entryDescription(entry),
    runtimeId: -(displayIndex + 1),
  }));
}

function notifyUndo(description: string): void {
  useNotificationStore.getState().info('Undone', description);
}

function notifyRedo(description: string): void {
  useNotificationStore.getState().info('Redone', description);
}

function notifyUndoRedoError(action: string, error: unknown): void {
  const message = error instanceof Error ? error.message : 'Please try again.';
  useNotificationStore.getState().error(`${action} failed`, message);
}

const managerCache = new WeakMap<IWorkspaceStoreClient, UndoManagerClient>();

function getManager(workspaceId: string | null): UndoManagerClient | undefined {
  if (!workspaceId) return undefined;
  const client = getWorkspaceStoreClient(workspaceId);
  if (!client) return undefined;
  let manager = managerCache.get(client);
  if (!manager) {
    manager = createUndoManagerClient(client);
    managerCache.set(client, manager);
  }
  return manager;
}

export const useUndoStore = create<UndoState>()((set, get) => {
  let unsubscribeManager: (() => void) | undefined;

  const syncWithManager = async (workspaceId: string | null) => {
    const manager = getManager(workspaceId);
    if (!manager) {
      set({
        canUndo: false,
        canRedo: false,
        undoEntries: [],
        redoEntries: [],
        runtimeVersion: get().runtimeVersion + 1,
      });
      return;
    }

    const [canUndo, canRedo, stacks] = await Promise.all([
      manager.canUndo(),
      manager.canRedo(),
      manager.getStacks(),
    ]);
    // Undo stack: newest first for display (reverse of internal storage)
    const undoEntries = buildLocalEntries([...stacks.undo].reverse());
    // Redo stack: oldest first for display (same as internal storage)
    const redoEntries = buildLocalEntries(stacks.redo);

    set({
      canUndo,
      canRedo,
      undoEntries,
      redoEntries,
      runtimeVersion: get().runtimeVersion + 1,
    });
  };

  const attachManager = (workspaceId: string | null) => {
    if (unsubscribeManager) {
      unsubscribeManager();
      unsubscribeManager = undefined;
    }
    const manager = getManager(workspaceId);
    if (manager) {
      unsubscribeManager = manager.subscribe(() => {
        void syncWithManager(workspaceId);
      });
    }
    void syncWithManager(workspaceId);
  };

  return {
    currentWorkspaceId: null,
    canUndo: false,
    canRedo: false,
    undoEntries: [],
    redoEntries: [],
    runtimeVersion: 0,

    setWorkspaceId: (workspaceId) => {
      if (get().currentWorkspaceId === workspaceId) return;
      set({ currentWorkspaceId: workspaceId });
      attachManager(workspaceId);
    },

    refreshStack: async () => {
      await syncWithManager(get().currentWorkspaceId);
    },

    syncRuntimeState: async () => {
      await syncWithManager(get().currentWorkspaceId);
    },

    performUndo: async (queryClient: QueryClient) => {
      const workspaceId = get().currentWorkspaceId;
      const manager = getManager(workspaceId);

      if (!manager) {
        await get().refreshStack();
        return;
      }

      try {
        const entry = await manager.undo();
        if (entry) {
          notifyUndo(entryDescription(entry));
          await queryClient.invalidateQueries({ queryKey: nodeKeys.lists() });
        }
      } catch (error) {
        notifyUndoRedoError('Undo', error);
      } finally {
        await get().refreshStack();
      }
    },

    performRedo: async (queryClient: QueryClient) => {
      const workspaceId = get().currentWorkspaceId;
      const manager = getManager(workspaceId);

      if (!manager) {
        await get().refreshStack();
        return;
      }

      try {
        const entry = await manager.redo();
        if (entry) {
          notifyRedo(entryDescription(entry));
          await queryClient.invalidateQueries({ queryKey: nodeKeys.lists() });
        }
      } catch (error) {
        notifyUndoRedoError('Redo', error);
      } finally {
        await get().refreshStack();
      }
    },

    performUndoTo: async (queryClient: QueryClient, entry: UnifiedUndoEntry) => {
      const workspaceId = get().currentWorkspaceId;
      const manager = getManager(workspaceId);

      if (!manager || entry.runtimeId == null || entry.runtimeId >= 0) {
        await get().refreshStack();
        return;
      }

      try {
        const steps = Math.abs(entry.runtimeId);
        let lastDescription = '';
        for (let i = 0; i < steps; i++) {
          const localEntry = await manager.undo();
          if (localEntry) lastDescription = entryDescription(localEntry);
        }
        if (lastDescription) notifyUndo(lastDescription);
        await queryClient.invalidateQueries({ queryKey: nodeKeys.lists() });
      } catch (error) {
        notifyUndoRedoError('Undo', error);
      } finally {
        await get().refreshStack();
      }
    },

    performRedoTo: async (queryClient: QueryClient, entry: UnifiedUndoEntry) => {
      const workspaceId = get().currentWorkspaceId;
      const manager = getManager(workspaceId);

      if (!manager || entry.runtimeId == null || entry.runtimeId >= 0) {
        await get().refreshStack();
        return;
      }

      try {
        const steps = Math.abs(entry.runtimeId);
        let lastDescription = '';
        for (let i = 0; i < steps; i++) {
          const localEntry = await manager.redo();
          if (localEntry) lastDescription = entryDescription(localEntry);
        }
        if (lastDescription) notifyRedo(lastDescription);
        await queryClient.invalidateQueries({ queryKey: nodeKeys.lists() });
      } catch (error) {
        notifyUndoRedoError('Redo', error);
      } finally {
        await get().refreshStack();
      }
    },

    clearHistory: async () => {
      const workspaceId = get().currentWorkspaceId;
      const manager = getManager(workspaceId);
      if (manager) {
        await manager.clear();
      }
      useNotificationStore.getState().success('History cleared', 'Undo/redo history has been cleared.');
      set({ canUndo: false, canRedo: false, undoEntries: [], redoEntries: [] });
    },
  };
});

export async function invalidateForEntity(queryClient: QueryClient, _entityType: string, entityUuid: string) {
  // Broad invalidation to ensure UI consistency after undo/redo
  await queryClient.invalidateQueries({ queryKey: nodeKeys.detailBase(entityUuid) });
  await queryClient.invalidateQueries({ queryKey: nodeKeys.pageContent(entityUuid) });
  await queryClient.invalidateQueries({ queryKey: nodeKeys.backlinks(entityUuid) });
  await queryClient.invalidateQueries({ queryKey: nodeKeys.linkedRefs(entityUuid) });
  await queryClient.invalidateQueries({ queryKey: nodeKeys.lists() });
  await queryClient.invalidateQueries({ queryKey: nodeKeys.classes() });
  await queryClient.invalidateQueries({ queryKey: propertyKeys.all });
}
