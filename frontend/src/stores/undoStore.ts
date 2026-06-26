import { create } from 'zustand';
import { type QueryClient } from '@tanstack/react-query';
import * as undoApi from '@/api/undo';
import type { UndoStackEntry } from '@/api/undo';
import type { UndoEntry } from '@/runtime/types';
import { getUndoEngine } from './undoEngine';
import { awaitAllContentSaves } from '@/hooks/contentSaveTracker';
import { nodeKeys, propertyKeys } from '@/hooks/queryKeys';
import { useNotificationStore } from '@/stores/notificationStore';

interface UnifiedUndoEntry extends UndoStackEntry {
  /** Negative IDs indicate runtime (local) entries. */
  runtimeId?: number;
}

interface UndoState {
  canUndo: boolean;
  canRedo: boolean;
  undoEntries: UnifiedUndoEntry[];
  redoEntries: UnifiedUndoEntry[];
  /** Bump this to force consumers to re-evaluate runtime state. */
  runtimeVersion: number;
  refreshStack: (queryClient?: QueryClient) => Promise<void>;
  syncRuntimeState: () => void;
  performUndo: (queryClient: QueryClient) => Promise<void>;
  performRedo: (queryClient: QueryClient) => Promise<void>;
  performUndoTo: (queryClient: QueryClient, entry: UnifiedUndoEntry) => Promise<void>;
  performRedoTo: (queryClient: QueryClient, entry: UnifiedUndoEntry) => Promise<void>;
  clearHistory: () => Promise<void>;
}

/** Generate a display label from a runtime undo entry. */
function runtimeEntryDescription(entry: UndoEntry): string {
  return entry.label || 'Edit';
}

/** Build synthetic UndoStackEntry rows from the runtime stacks. */
function buildRuntimeEntries(stack: UndoEntry[]): UnifiedUndoEntry[] {
  // Assign negative IDs based on display order (top/first = -1, next = -2, …).
  // For both undo and redo stacks we display in the same order the arrays
  // are returned: undo newest-first (reverse of storage), redo oldest-first.
  return stack.map((entry, displayIndex) => ({
    nodeUuid: '',
    uuid: '',
    operation: entry.forward.type === 'batch' ? 'batch' : entry.forward.type,
    entity_type: 'node',
    entity_id: '',
    description: runtimeEntryDescription(entry),
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

export const useUndoStore = create<UndoState>()((set, get) => ({
  canUndo: false,
  canRedo: false,
  undoEntries: [],
  redoEntries: [],
  runtimeVersion: 0,

  refreshStack: async () => {
    const engine = getUndoEngine();
    let backendStack: undoApi.UndoStack | null = null;
    try {
      backendStack = await undoApi.getUndoStack();
    } catch {
      // Ignore errors (e.g. not authenticated)
    }

    // Undo stack: newest first for display (reverse of internal storage)
    const runtimeUndo = buildRuntimeEntries([...engine.getUndoStack()].reverse());
    // Redo stack: oldest first for display (same as internal storage)
    const runtimeRedo = buildRuntimeEntries(engine.getRedoStack());

    const undoEntries: UnifiedUndoEntry[] = [
      ...runtimeUndo,
      ...(backendStack?.undo_entries ?? []),
    ];
    const redoEntries: UnifiedUndoEntry[] = [
      ...runtimeRedo,
      ...(backendStack?.redo_entries ?? []),
    ];

    set({
      canUndo: undoEntries.length > 0,
      canRedo: redoEntries.length > 0,
      undoEntries,
      redoEntries,
      runtimeVersion: get().runtimeVersion + 1,
    });
  },

  syncRuntimeState: () => {
    const engine = getUndoEngine();
    // Preserve backend entries that are already in state
    const backendUndoEntries = get().undoEntries.filter(e => e.runtimeId == null);
    const backendRedoEntries = get().redoEntries.filter(e => e.runtimeId == null);

    const runtimeUndo = buildRuntimeEntries([...engine.getUndoStack()].reverse());
    const runtimeRedo = buildRuntimeEntries(engine.getRedoStack());

    const undoEntries: UnifiedUndoEntry[] = [...runtimeUndo, ...backendUndoEntries];
    const redoEntries: UnifiedUndoEntry[] = [...runtimeRedo, ...backendRedoEntries];

    set({
      canUndo: undoEntries.length > 0,
      canRedo: redoEntries.length > 0,
      undoEntries,
      redoEntries,
      runtimeVersion: get().runtimeVersion + 1,
    });
  },

  performUndo: async (queryClient: QueryClient) => {
    const engine = getUndoEngine();

    try {
      await awaitAllContentSaves();
    } catch {
      // Proceed with undo even if flush times out; local state is still valid.
    }

    // 1. Try runtime first (local block operations are always more recent)
    const localEntry = engine.undo();
    if (localEntry) {
      notifyUndo(runtimeEntryDescription(localEntry));
      await queryClient.invalidateQueries({ queryKey: nodeKeys.lists() });
      await get().refreshStack();
      return;
    }

    // 2. Fall back to backend undo log
    try {
      const result = await undoApi.undo();
      notifyUndo(result.description);
      await invalidateForEntity(queryClient, result.entity_type, result.entity_id);
      await get().refreshStack();
    } catch (error) {
      notifyUndoRedoError('Undo', error);
      await get().refreshStack();
    }
  },

  performRedo: async (queryClient: QueryClient) => {
    const engine = getUndoEngine();

    try {
      await awaitAllContentSaves();
    } catch {
      // Proceed even if flush times out.
    }

    // 1. Try backend first (backend redos are the most recently undone persisted ops)
    try {
      const result = await undoApi.redo();
      notifyRedo(result.description);
      await invalidateForEntity(queryClient, result.entity_type, result.entity_id);
      await get().refreshStack();
      return;
    } catch (error) {
      // 404 = nothing on backend to redo — fall through to runtime
      const apiError = error as { response?: { status?: number } };
      if (apiError.response?.status !== 404) {
        notifyUndoRedoError('Redo', error);
        await get().refreshStack();
        return;
      }
    }

    // 2. Fall back to runtime redo stack
    const localEntry = engine.redo();
    if (localEntry) {
      notifyRedo(runtimeEntryDescription(localEntry));
      await queryClient.invalidateQueries({ queryKey: nodeKeys.lists() });
      await get().refreshStack();
    } else {
      await get().refreshStack();
    }
  },

  performUndoTo: async (queryClient: QueryClient, entry: UnifiedUndoEntry) => {
    const engine = getUndoEngine();

    try {
      await awaitAllContentSaves();
    } catch {
      // Proceed even if flush times out.
    }

    if (entry.runtimeId != null && entry.runtimeId < 0) {
      // Target is a runtime entry — undo N times where N is the display position.
      const steps = Math.abs(entry.runtimeId);
      let lastDescription = '';
      for (let i = 0; i < steps; i++) {
        const localEntry = engine.undo();
        if (localEntry) lastDescription = runtimeEntryDescription(localEntry);
      }
      if (lastDescription) notifyUndo(lastDescription);
      await queryClient.invalidateQueries({ queryKey: nodeKeys.lists() });
      await get().refreshStack();
      return;
    }

    // Target is a backend entry
    try {
      const results = await undoApi.undoTo(entry.uuid);
      if (results.length > 0) {
        notifyUndo(results[0].description);
      }
      for (const r of results) {
        await invalidateForEntity(queryClient, r.entity_type, r.entity_id);
      }
      await get().refreshStack();
    } catch (error) {
      notifyUndoRedoError('Undo', error);
      await get().refreshStack();
    }
  },

  performRedoTo: async (queryClient: QueryClient, entry: UnifiedUndoEntry) => {
    const engine = getUndoEngine();

    try {
      await awaitAllContentSaves();
    } catch {
      // Proceed even if flush times out.
    }

    if (entry.runtimeId != null && entry.runtimeId < 0) {
      // Target is a runtime entry — redo N times where N is the display position.
      const steps = Math.abs(entry.runtimeId);
      let lastDescription = '';
      for (let i = 0; i < steps; i++) {
        const localEntry = engine.redo();
        if (localEntry) lastDescription = runtimeEntryDescription(localEntry);
      }
      if (lastDescription) notifyRedo(lastDescription);
      await queryClient.invalidateQueries({ queryKey: nodeKeys.lists() });
      await get().refreshStack();
      return;
    }

    // Target is a backend entry
    try {
      const results = await undoApi.redoTo(entry.uuid);
      if (results.length > 0) {
        notifyRedo(results[results.length - 1].description);
      }
      for (const r of results) {
        await invalidateForEntity(queryClient, r.entity_type, r.entity_id);
      }
      await get().refreshStack();
    } catch (error) {
      notifyUndoRedoError('Redo', error);
      await get().refreshStack();
    }
  },

  clearHistory: async () => {
    const engine = getUndoEngine();
    engine.clearUndoRedo();
    try {
      await undoApi.clearHistory();
      useNotificationStore.getState().success('History cleared', 'Undo/redo history has been cleared.');
    } catch (error) {
      notifyUndoRedoError('Clear history', error);
    }
    set({ canUndo: false, canRedo: false, undoEntries: [], redoEntries: [] });
  },
}));

async function invalidateForEntity(queryClient: QueryClient, _entityType: string, entityUuid: string) {
  // Broad invalidation to ensure UI consistency after undo/redo
  await queryClient.invalidateQueries({ queryKey: nodeKeys.detailBase(entityUuid) });
  await queryClient.invalidateQueries({ queryKey: nodeKeys.pageContent(entityUuid) });
  await queryClient.invalidateQueries({ queryKey: nodeKeys.backlinks(entityUuid) });
  await queryClient.invalidateQueries({ queryKey: nodeKeys.linkedRefs(entityUuid) });
  await queryClient.invalidateQueries({ queryKey: nodeKeys.lists() });
  await queryClient.invalidateQueries({ queryKey: nodeKeys.classes() });
  await queryClient.invalidateQueries({ queryKey: propertyKeys.all });
}
