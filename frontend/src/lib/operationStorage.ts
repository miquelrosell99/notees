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

/** Per-node sequence vector used by the legacy v2 outbox format. */
type BaseVector = Record<string, number>;

const STORAGE_KEY = 'notees-pending-operations';
const OUTBOX_STATE_KEY = 'notees-outbox-state-v2';

// In environments without IndexedDB (e.g. jsdom during tests) fall back to a
// simple in-memory store so that LocalSyncEngine never throws.
const memoryStore = new Map<string, unknown>();
const hasIndexedDB = typeof indexedDB !== 'undefined';

async function idbGet<T>(key: string): Promise<T | undefined> {
  if (hasIndexedDB) return get<T>(key);
  return memoryStore.get(key) as T | undefined;
}

async function idbSet(key: string, value: unknown): Promise<void> {
  if (hasIndexedDB) {
    await set(key, value);
  } else {
    memoryStore.set(key, value);
  }
}

async function getStored(): Promise<Operation[]> {
  const value = await idbGet<Operation[]>(STORAGE_KEY);
  if (Array.isArray(value)) return value;
  return [];
}

async function setStored(operations: Operation[]): Promise<void> {
  await idbSet(STORAGE_KEY, operations);
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

export interface OutboxEntry {
  op: Operation;
  attemptCount: number;
  lastError: string | null;
  nextRetryAt: number | null;
  createdAt: number;
}

export interface OutboxStateV2 {
  entries: OutboxEntry[];
  ackedVector: BaseVector;
  nextSeq: number;
}

function migrateLegacyOutboxState(value: unknown): OutboxStateV2 | null {
  if (!value || typeof value !== 'object') return null;
  const state = value as Record<string, unknown>;
  if (!Array.isArray(state.operations)) return null;
  // Legacy format stored plain Operation[]; migrate to OutboxEntry[].
  const entries: OutboxEntry[] = (state.operations as Operation[]).map((op) => ({
    op,
    attemptCount: 0,
    lastError: null,
    nextRetryAt: null,
    createdAt: Date.now(),
  }));
  return {
    entries,
    ackedVector: (state.ackedVector as BaseVector) ?? {},
    nextSeq: typeof state.nextSeq === 'number' ? state.nextSeq : 0,
  };
}

/**
 * Save the v2 outbox state (pending entries + last acked vector + next seq).
 */
export async function saveOutboxStateV2(state: OutboxStateV2): Promise<void> {
  await idbSet(OUTBOX_STATE_KEY, state);
}

/**
 * Load the v2 outbox state. Returns a default empty state if missing.
 * Migrates legacy plain-operation storage on first read.
 */
export async function loadOutboxStateV2(): Promise<OutboxStateV2> {
  const value = await idbGet<OutboxStateV2>(OUTBOX_STATE_KEY);
  if (value && typeof value === 'object') {
    const maybeLegacy = migrateLegacyOutboxState(value);
    if (maybeLegacy) return maybeLegacy;
    const state = value as OutboxStateV2;
    if (Array.isArray(state.entries)) {
      return state;
    }
  }
  return { entries: [], ackedVector: {}, nextSeq: 0 };
}

/**
 * Clear the v2 outbox state.
 */
export async function clearOutboxStateV2(): Promise<void> {
  await idbSet(OUTBOX_STATE_KEY, { entries: [], ackedVector: {}, nextSeq: 0 });
}
