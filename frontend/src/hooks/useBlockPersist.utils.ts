/**
 * useBlockPersist utilities — coordinated singleton state & helpers
 */

import { batchDeleteNodes as batchDeleteNodesApi, updateNode as updateNodeApi } from '@/api/nodes';
import { queryClient as sharedQueryClient } from '@/lib/queryClient';
import { nodeKeys } from './queryKeys';
import type { ASTDocument } from '@/types/ast';
import { parseAST, convertMarkdownInAST } from '@/lib/astBuilder';

export function isRetryableError(error: unknown): boolean {
  const axiosError = error as { response?: { status?: number }; message?: string };
  const status = axiosError.response?.status;
  return status == null || status >= 500;
}

// ─── Singleton coordinator ────────────────────────────────────────

class BlockPersistCoordinator {
  activeInstanceId: string | null = null;
  inFlightBlocks = new Set<string>();
  pendingContentSaves = new Map<string, string>();
  pendingDeleteUuids: string[] = [];
  deleteFlushScheduled = false;

  queueContentSave(blockId: string, content: string): void {
    this.pendingContentSaves.set(blockId, content);
  }

  isBlockPending(blockId: string): boolean {
    return this.inFlightBlocks.has(blockId) || this.pendingContentSaves.has(blockId);
  }

  scheduleDeleteFlush(): void {
    if (this.deleteFlushScheduled) return;
    this.deleteFlushScheduled = true;
    queueMicrotask(() => {
      this.deleteFlushScheduled = false;
      const uuids = this.pendingDeleteUuids;
      this.pendingDeleteUuids = [];
      if (uuids.length === 0) return;
      batchDeleteNodesApi({ uuids }).then(() => {
        sharedQueryClient.invalidateQueries({ queryKey: ['nodeViews', 'queryResults'], refetchType: 'none' });
        sharedQueryClient.invalidateQueries({ queryKey: nodeKeys.pseudoNodeQuery(), refetchType: 'none' });
        sharedQueryClient.invalidateQueries({ queryKey: nodeKeys.inlineQuery(), refetchType: 'none' });
        sharedQueryClient.invalidateQueries({ queryKey: ['nodes', 'linked-refs'], refetchType: 'none' });
        sharedQueryClient.invalidateQueries({ queryKey: ['nodes', 'property-backlinks'], refetchType: 'none' });
        sharedQueryClient.invalidateQueries({ queryKey: ['nodes', 'backlinks'], refetchType: 'none' });
      }).catch((error) => {
        console.error('[useBlockPersist] Failed to batch-delete blocks:', error);
      });
    });
  }

  reset(): void {
    this.activeInstanceId = null;
    this.inFlightBlocks.clear();
    this.pendingContentSaves.clear();
    this.pendingDeleteUuids = [];
    this.deleteFlushScheduled = false;
  }
}

/** Singleton coordinator for cross-instance block persist state */
export const coordinator = new BlockPersistCoordinator();

// Convenience re-exports (objects/methods are stable references)
export const inFlightBlocks = coordinator.inFlightBlocks;
export const pendingContentSaves = coordinator.pendingContentSaves;
export const pendingDeleteUuids = coordinator.pendingDeleteUuids;
export const deleteFlushScheduled = coordinator.deleteFlushScheduled;

export function queueContentSave(blockId: string, content: string): void {
  coordinator.queueContentSave(blockId, content);
}

export function isBlockPending(blockId: string): boolean {
  return coordinator.isBlockPending(blockId);
}

export function scheduleDeleteFlush(): void {
  coordinator.scheduleDeleteFlush();
}

export function setActiveInstanceId(id: string | null): void {
  coordinator.activeInstanceId = id;
}

export function getActiveInstanceId(): string | null {
  return coordinator.activeInstanceId;
}

// ─── Helpers ──────────────────────────────────────────────────────

export function serializeContentForAPI(contentAST: ASTDocument): string {
  if (!contentAST || contentAST.length === 0) return '';

  const firstBlock = contentAST[0];
  const isEffectivelyEmpty = contentAST.length === 1 &&
    firstBlock.children &&
    firstBlock.children.length <= 1 &&
    (!firstBlock.children[0] ||
      ('text' in firstBlock.children[0] && firstBlock.children[0].text === ''));

  if (isEffectivelyEmpty) return '';

  return JSON.stringify(contentAST);
}

export function flushQueuedContent(serverId: number, content: string): Promise<void> {
  const ast = parseAST(content);
  const converted = convertMarkdownInAST(ast);
  const finalContent = converted !== ast ? JSON.stringify(converted) : content;

  return updateNodeApi(serverId, { name: finalContent }).then(() => {}).catch((error) => {
    console.error('[useBlockPersist] Failed to flush content for serverId:', serverId, error);
  });
}
