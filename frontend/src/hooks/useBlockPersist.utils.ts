/**
 * useBlockPersist utilities — module-level state & helpers
 */

import { batchDeleteNodes as batchDeleteNodesApi, updateNode as updateNodeApi } from '@/api/nodes';
import { queryClient as sharedQueryClient } from '@/lib/queryClient';
import { offlineQueue } from '@/lib/offlineQueue';
import { nodeKeys } from './queryKeys';
import type { ASTDocument } from '@/types/ast';
import { parseAST, convertMarkdownInAST } from '@/lib/astBuilder';

export function isRetryableError(error: unknown): boolean {
  const axiosError = error as { response?: { status?: number }; message?: string };
  const status = axiosError.response?.status;
  return status == null || status >= 500;
}

// ─── Singleton state ──────────────────────────────────────────────

export let activeInstanceId: string | null = null;

/**
 * Set of blockIds currently being persisted (in-flight API calls).
 * Prevents duplicate persist attempts for the same block.
 */
export const inFlightBlocks = new Set<string>();

/**
 * Queued content saves: blockId (UUID) → latest content string.
 * When a content change fires for a block without serverId, we store
 * it here and flush it once the serverId arrives.
 */
export const pendingContentSaves = new Map<string, string>();

/** Register a content save to flush after the block gets a serverId */
export function queueContentSave(blockId: string, content: string): void {
  pendingContentSaves.set(blockId, content);
}

/** Check if a block is currently being persisted or queued */
export function isBlockPending(blockId: string): boolean {
  return inFlightBlocks.has(blockId) || pendingContentSaves.has(blockId);
}

/**
 * Pending batch delete: collects block UUIDs from block_deleted events
 * within one microtask and flushes them as a single batchDeleteNodes call.
 */
export let pendingDeleteUuids: string[] = [];
export let deleteFlushScheduled = false;

export function scheduleDeleteFlush(): void {
  if (deleteFlushScheduled) return;
  deleteFlushScheduled = true;
  queueMicrotask(() => {
    deleteFlushScheduled = false;
    const uuids = pendingDeleteUuids;
    pendingDeleteUuids = [];
    if (uuids.length === 0) return;
    batchDeleteNodesApi({ uuids }).then(() => {
      // Soft-invalidate query result caches so views reflect the deletion
      // on their next natural refresh. Active refetch causes visible spinner
      // flashes because every block delete would trigger a full re-fetch.
      sharedQueryClient.invalidateQueries({ queryKey: ['nodeViews', 'queryResults'], refetchType: 'none' });
      sharedQueryClient.invalidateQueries({ queryKey: nodeKeys.pseudoNodeQuery(), refetchType: 'none' });
      sharedQueryClient.invalidateQueries({ queryKey: nodeKeys.inlineQuery(), refetchType: 'none' });
      // Invalidate backlinks and linked references since deleted blocks may have been referenced
      sharedQueryClient.invalidateQueries({ queryKey: ['nodes', 'linked-refs'], refetchType: 'none' });
      sharedQueryClient.invalidateQueries({ queryKey: ['nodes', 'property-backlinks'], refetchType: 'none' });
      sharedQueryClient.invalidateQueries({ queryKey: ['nodes', 'backlinks'], refetchType: 'none' });
    }).catch((error) => {
      if (isRetryableError(error)) {
        for (const uuid of uuids) {
          offlineQueue.enqueue({
            type: 'delete_block',
            blockUuid: uuid,
          }).catch(console.error);
        }
      } else {
        console.error('[useBlockPersist] Failed to batch-delete blocks:', error);
      }
    });
  });
}
// ─── Helpers ──────────────────────────────────────────────────────

/**
 * Serialize a ContentAST to a string suitable for the `name` field.
 * For newly-created blocks this is typically empty or minimal.
 */
export function serializeContentForAPI(contentAST: ASTDocument): string {
  if (!contentAST || contentAST.length === 0) return '';

  // Check if it's just an empty paragraph
  const firstBlock = contentAST[0];
  const isEffectivelyEmpty = contentAST.length === 1 &&
    firstBlock.children &&
    firstBlock.children.length <= 1 &&
    (!firstBlock.children[0] || 
      ('text' in firstBlock.children[0] && firstBlock.children[0].text === ''));

  if (isEffectivelyEmpty) return '';

  // For non-empty content, serialize as JSON AST (the format the backend expects)
  return JSON.stringify(contentAST);
}

/**
 * Flush a queued content save now that the block has a serverId.
 * Calls the update API directly — converts markdown syntax in AST first.
 * Returns a Promise so callers can defer cache invalidation until the save completes.
 */
export function flushQueuedContent(serverId: number, content: string): Promise<void> {
  // Match the same conversion logic as useContentSave.saveBlock
  const ast = parseAST(content);
  const converted = convertMarkdownInAST(ast);
  const finalContent = converted !== ast ? JSON.stringify(converted) : content;

  return updateNodeApi(serverId, { name: finalContent }).then(() => {}).catch((error) => {
    console.error('[useBlockPersist] Failed to flush content for serverId:', serverId, error);
  });
}

export function setActiveInstanceId(id: string | null): void {
  activeInstanceId = id;
}
