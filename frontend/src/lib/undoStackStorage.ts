/**
 * Persistent storage for the runtime undo/redo stacks.
 *
 * Mirrors the pending-intent storage pattern: stacks are saved to IndexedDB
 * whenever they change, and restored on app startup after nodes are loaded.
 * Entries that reference blocks no longer present in the runtime are discarded.
 */

import { get, set } from 'idb-keyval';
import type { MutationIntent, UndoEntry } from '@/runtime/types';
import { getOperationRuntime } from '@/runtime';
import { getUndoEngine } from '@/stores/undoEngine';

const STORAGE_KEY = 'notees-undo-stacks';

interface StoredStacks {
  undo: UndoEntry[];
  redo: UndoEntry[];
  savedAt: number;
}

function getAffectedBlockIds(intent: MutationIntent): string[] {
  switch (intent.type) {
    case 'update_content':
    case 'split_block':
    case 'delete_block':
    case 'indent_block':
    case 'outdent_block':
    case 'move_up':
    case 'move_down':
    case 'toggle_collapsed':
    case 'set_collapsed':
    case 'set_node_type':
      return [intent.blockId];
    case 'merge_blocks':
      return [intent.sourceBlockId, intent.targetBlockId];
    case 'create_block':
      return [intent.blockId];
    case 'move_block':
      return [intent.blockId];
    case 'reorder_blocks':
      return intent.orderedBlockIds;
    case 'batch':
      return intent.intents.flatMap(getAffectedBlockIds);
    default:
      return [];
  }
}

function entryIsRestorable(entry: UndoEntry): boolean {
  const runtime = getOperationRuntime();
  const blockIds = new Set([
    ...getAffectedBlockIds(entry.forward),
    ...getAffectedBlockIds(entry.reverse),
  ]);
  for (const blockId of blockIds) {
    if (!runtime.getNode(blockId)) {
      return false;
    }
  }
  return true;
}

export async function saveUndoStacks(undo: UndoEntry[], redo: UndoEntry[]): Promise<void> {
  const payload: StoredStacks = { undo, redo, savedAt: Date.now() };
  try {
    await set(STORAGE_KEY, payload);
  } catch (error) {
    console.error('[undoStackStorage] Failed to save undo stacks:', error);
  }
}

export async function restoreUndoStacks(): Promise<void> {
  const value = await get(STORAGE_KEY);
  if (!value || typeof value !== 'object') return;

  const stored = value as StoredStacks;
  if (!Array.isArray(stored.undo) || !Array.isArray(stored.redo)) return;

  const undo = stored.undo.filter(entryIsRestorable);
  const redo = stored.redo.filter(entryIsRestorable);

  if (undo.length > 0 || redo.length > 0) {
    getUndoEngine().restoreUndoStacks(undo, redo);
  }

  // Clear storage after restore so stale entries don't accumulate.
  await set(STORAGE_KEY, { undo: [], redo: [], savedAt: Date.now() });
}

export async function clearUndoStackStorage(): Promise<void> {
  await set(STORAGE_KEY, { undo: [], redo: [], savedAt: Date.now() });
}
