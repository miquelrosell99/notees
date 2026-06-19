/**
 * Operation Storage
 *
 * Persists pending OperationRuntime operations to IndexedDB so they survive
 * page reloads. On app startup, saved operations are restored into the runtime.
 *
 * Only operations whose target blocks still exist (in runtime or cache) are
 * restored. Create operations are restored because they themselves create the
 * block; update/delete/move operations require the block to exist in base state.
 */

import { get, set } from 'idb-keyval';
import { getOperationRuntime } from '@/runtime';
import type { Operation } from '@/runtime';

const STORAGE_KEY = 'notees-pending-operations';

async function getStored(): Promise<Operation[]> {
  const value = await get(STORAGE_KEY);
  if (Array.isArray(value)) return value;
  return [];
}

async function setStored(operations: Operation[]): Promise<void> {
  await set(STORAGE_KEY, operations);
}

function getAffectedBlockIds(operation: Operation): string[] {
  switch (operation.type) {
    case 'create':
    case 'update_content':
    case 'delete':
    case 'move':
    case 'set_collapsed':
    case 'set_classes':
    case 'set_tags':
      return [operation.blockId];
    default:
      return [];
  }
}

/**
 * Save all current pending operations from the runtime to IndexedDB.
 *
 * Acknowledged operations are filtered out: they are waiting for a base-state
 * update that will happen on the next render, so there is no value in
 * persisting them across reloads.
 */
export async function saveOperations(): Promise<void> {
  const runtime = getOperationRuntime();
  const operations = runtime
    .getOperations()
    .filter((op) => op.state !== 'acknowledged');
  await setStored(operations as Operation[]);
}

/**
 * Load operations from IndexedDB and inject them into the runtime.
 * Operations for blocks that no longer exist are silently discarded.
 */
export async function restoreOperations(): Promise<void> {
  const stored = await getStored();
  if (stored.length === 0) return;

  const runtime = getOperationRuntime();

  for (const operation of stored) {
    const blockIds = getAffectedBlockIds(operation);

    // Create operations are self-contained: they create their own block.
    // All other operations require the block to exist in base state.
    const canRestore =
      operation.type === 'create' || blockIds.every((blockId) => runtime.getNode(blockId) != null);

    if (!canRestore) continue;

    runtime.applyOperation(operation);
  }

  // Clear storage after restore
  await setStored([]);
}

/**
 * Clear all stored operations (e.g. on explicit logout/reset).
 */
export async function clearOperationStorage(): Promise<void> {
  await setStored([]);
}
