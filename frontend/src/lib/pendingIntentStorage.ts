/**
 * Pending Intent Storage
 *
 * Persists the runtime's pending intents to IndexedDB so they survive
 * page reloads. On app startup, saved intents are restored into the runtime.
 *
 * Note: Only intents whose target blocks still exist (in runtime or cache)
 * are restored. Intents for blocks that were never persisted and are no
 * longer in memory are discarded.
 */

import { get, set } from 'idb-keyval';
import type { MutationIntent } from '@/runtime/types';
import { getNodeGraphRuntime } from '@/runtime/NodeGraphRuntime';

const STORAGE_KEY = 'notees-pending-intents';

interface StoredIntent {
  intent: MutationIntent;
  timestamp: number;
  mutationKey: string;
}

async function _getStored(): Promise<StoredIntent[]> {
  const value = await get(STORAGE_KEY);
  if (Array.isArray(value)) return value;
  return [];
}

async function _setStored(intents: StoredIntent[]): Promise<void> {
  await set(STORAGE_KEY, intents);
}

/**
 * Save all current pending intents from the runtime to IndexedDB.
 */
export async function savePendingIntents(): Promise<void> {
  const runtime = getNodeGraphRuntime();
  const allPending = runtime.getAllPendingIntents();
  const toStore: StoredIntent[] = allPending.map(p => ({
    intent: p.intent,
    timestamp: p.timestamp,
    mutationKey: p.mutationKey,
  }));
  await _setStored(toStore);
}

/**
 * Load pending intents from IndexedDB and inject them into the runtime.
 * Intents for blocks that no longer exist are silently discarded.
 */
export async function restorePendingIntents(): Promise<void> {
  const stored = await _getStored();
  if (stored.length === 0) return;

  const runtime = getNodeGraphRuntime();

  for (const item of stored) {
    const blockIds = getAffectedBlockIds(item.intent);
    let allBlocksExist = true;

    for (const blockId of blockIds) {
      if (!runtime.getNode(blockId)) {
        allBlocksExist = false;
        break;
      }
    }

    if (!allBlocksExist) continue;

    runtime.restorePendingIntent(item.intent, item.timestamp, item.mutationKey);
  }

  // Clear storage after restore
  await _setStored([]);
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
      return [];
    default:
      return [];
  }
}

/**
 * Clear all stored pending intents (e.g. on explicit logout/reset).
 */
export async function clearPendingIntentStorage(): Promise<void> {
  await _setStored([]);
}
