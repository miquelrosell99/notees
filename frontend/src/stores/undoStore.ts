import { create } from 'zustand';
import { type QueryClient } from '@tanstack/react-query';
import * as undoApi from '@/api/undo';
import type { UndoStackEntry } from '@/api/undo';
import type { UndoEntry } from '@/runtime/types';
import { getNodeGraphRuntime } from '@/runtime/NodeGraphRuntime';
import { nodeKeys, propertyKeys } from '@/hooks/queryKeys';

interface UnifiedUndoEntry extends UndoStackEntry {
  /** Negative IDs indicate runtime (local) entries. */
  id: number;
  description: string;
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
  performUndoTo: (queryClient: QueryClient, entryId: number) => Promise<void>;
  performRedoTo: (queryClient: QueryClient, entryId: number) => Promise<void>;
  clearHistory: () => Promise<void>;
}

/** Generate a display label from a runtime undo entry. */
function runtimeEntryDescription(entry: UndoEntry): string {
  return entry.label || 'Edit';
}

/** Build synthetic UndoStackEntry rows from the runtime stacks. */
function buildRuntimeEntries(
  stack: UndoEntry[],
): UnifiedUndoEntry[] {
  // Assign negative IDs based on display order (top/first = -1, next = -2, …).
  // For both undo and redo stacks we display in the same order the arrays
  // are returned: undo newest-first (reverse of storage), redo oldest-first.
  return stack.map((entry, displayIndex) => ({
    id: -(displayIndex + 1),
    operation: entry.forward.type === 'batch' ? 'batch' : entry.forward.type,
    entity_type: 'node',
    entity_id: 0,
    description: runtimeEntryDescription(entry),
  }));
}

export const useUndoStore = create<UndoState>()((set, get) => ({
  canUndo: false,
  canRedo: false,
  undoEntries: [],
  redoEntries: [],
  runtimeVersion: 0,

  refreshStack: async () => {
    const runtime = getNodeGraphRuntime();
    let backendStack: undoApi.UndoStack | null = null;
    try {
      backendStack = await undoApi.getUndoStack();
    } catch {
      // Ignore errors (e.g. not authenticated)
    }

    // Undo stack: newest first for display (reverse of internal storage)
    const runtimeUndo = buildRuntimeEntries([...runtime.getUndoStack()].reverse());
    // Redo stack: oldest first for display (same as internal storage)
    const runtimeRedo = buildRuntimeEntries(runtime.getRedoStack());

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
    const runtime = getNodeGraphRuntime();
    // Preserve backend entries that are already in state
    const backendUndoEntries = get().undoEntries.filter(e => e.id > 0);
    const backendRedoEntries = get().redoEntries.filter(e => e.id > 0);

    const runtimeUndo = buildRuntimeEntries([...runtime.getUndoStack()].reverse());
    const runtimeRedo = buildRuntimeEntries(runtime.getRedoStack());

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
    const runtime = getNodeGraphRuntime();

    // 1. Try runtime first (local block operations are always more recent)
    const localEntry = runtime.undo();
    if (localEntry) {
      // The reverse intent has been executed locally; it will generate its own
      // pending intent that useBlockPersist will sync. Invalidate broad caches
      // so TanStack Query reconciles with the runtime state.
      await queryClient.invalidateQueries({ queryKey: nodeKeys.lists() });
      await get().refreshStack();
      return;
    }

    // 2. Fall back to backend undo log
    try {
      const result = await undoApi.undo();
      await invalidateForEntity(queryClient, result.entity_type, result.entity_id);
      await get().refreshStack();
    } catch {
      await get().refreshStack();
    }
  },

  performRedo: async (queryClient: QueryClient) => {
    const runtime = getNodeGraphRuntime();

    // 1. Try backend first (backend redos are the most recently undone persisted ops)
    try {
      const result = await undoApi.redo();
      await invalidateForEntity(queryClient, result.entity_type, result.entity_id);
      await get().refreshStack();
      return;
    } catch {
      // 404 = nothing on backend to redo — fall through to runtime
    }

    // 2. Fall back to runtime redo stack
    const localEntry = runtime.redo();
    if (localEntry) {
      await queryClient.invalidateQueries({ queryKey: nodeKeys.lists() });
      await get().refreshStack();
    } else {
      await get().refreshStack();
    }
  },

  performUndoTo: async (queryClient: QueryClient, entryId: number) => {
    const runtime = getNodeGraphRuntime();

    if (entryId < 0) {
      // Target is a runtime entry — undo N times where N is the display position.
      const steps = Math.abs(entryId);
      for (let i = 0; i < steps; i++) {
        runtime.undo();
      }
      await queryClient.invalidateQueries({ queryKey: nodeKeys.lists() });
      await get().refreshStack();
      return;
    }

    // Target is a backend entry
    try {
      const results = await undoApi.undoTo(entryId);
      for (const r of results) {
        await invalidateForEntity(queryClient, r.entity_type, r.entity_id);
      }
      await get().refreshStack();
    } catch {
      await get().refreshStack();
    }
  },

  performRedoTo: async (queryClient: QueryClient, entryId: number) => {
    const runtime = getNodeGraphRuntime();

    if (entryId < 0) {
      // Target is a runtime entry — redo N times where N is the display position.
      const steps = Math.abs(entryId);
      for (let i = 0; i < steps; i++) {
        runtime.redo();
      }
      await queryClient.invalidateQueries({ queryKey: nodeKeys.lists() });
      await get().refreshStack();
      return;
    }

    // Target is a backend entry
    try {
      const results = await undoApi.redoTo(entryId);
      for (const r of results) {
        await invalidateForEntity(queryClient, r.entity_type, r.entity_id);
      }
      await get().refreshStack();
    } catch {
      await get().refreshStack();
    }
  },

  clearHistory: async () => {
    const runtime = getNodeGraphRuntime();
    runtime.clearUndoRedo();
    try {
      await undoApi.clearHistory();
    } catch {
      // ignore
    }
    set({ canUndo: false, canRedo: false, undoEntries: [], redoEntries: [] });
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
