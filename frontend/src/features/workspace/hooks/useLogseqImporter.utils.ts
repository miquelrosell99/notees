import { getNode, batchDeleteNodes, batchPermanentlyDeleteNodes } from '@/api/nodes';
import type { Node, PropertyType } from '@/types/api';
import type { QueryClient } from '@tanstack/react-query';
import type { PhaseResult } from './useLogseqImporter.types';
import { nodeKeys } from '@/hooks/queryKeys';


export function createPhase(label: string): PhaseResult {
  return { label, succeeded: 0, failed: 0, errors: [] };
}

export function errorMessage(e: unknown): string {
  if (typeof e === 'object' && e !== null && 'response' in e) {
    const resp = (e as { response?: { data?: { detail?: unknown } } }).response;
    const detail = resp?.data?.detail;
    if (detail) {
      if (typeof detail === 'string') return detail;
      if (Array.isArray(detail)) {
        return detail.map((d: { msg?: string }) => d.msg ?? JSON.stringify(d)).join('; ');
      }
      if (typeof detail === 'object' && detail !== null && 'message' in detail) {
        return String((detail as { message: unknown }).message);
      }
      return JSON.stringify(detail);
    }
  }
  if (e instanceof Error) return e.message;
  return String(e);
}

/**
 * Collect UUIDs and IDs recursively from children for deletion.
 * Used in override mode to delete existing blocks before importing.
 */
function collectChildInfo(node: Node): { uuids: string[]; ids: number[] } {
  const uuids: string[] = [];
  const ids: number[] = [];
  if (node.children && node.children.length > 0) {
    for (const child of node.children) {
      uuids.push(child.uuid);
      ids.push(child.id);
      const childInfo = collectChildInfo(child);
      uuids.push(...childInfo.uuids);
      ids.push(...childInfo.ids);
    }
  }
  return { uuids, ids };
}

/**
 * Delete all children of a page in override mode.
 * Two-step: soft-delete first, then hard-delete to free UUIDs.
 */
export async function deleteExistingBlocks(pageId: number, queryClient: QueryClient): Promise<number> {
  const fullPage = await getNode(pageId, { include_children: true });
  const { uuids: childUuids, ids: childIds } = collectChildInfo(fullPage);

  if (childUuids.length === 0) return 0;

  const result = await batchDeleteNodes({ uuids: childUuids });

  if (childIds.length > 0) {
    try {
      await batchPermanentlyDeleteNodes({ ids: childIds });
    } catch (e) {
      console.warn('[IMPORT] Hard-delete of old blocks failed (non-critical):', e);
    }
  }

  queryClient.invalidateQueries({ queryKey: nodeKeys.detailBase(pageId) });

  return result.deleted;
}

/** Count blocks recursively — exported so UI components can show preview counts */
export function countBlocks(blocks: { children?: unknown[] }[]): number {
  let n = blocks.length;
  for (const b of blocks) {
    if (b.children) n += countBlocks(b.children as { children?: unknown[] }[]);
  }
  return n;
}

/** Map Logseq property type → Notees property type */
export function mapPropertyType(logseqType: string): PropertyType {
  switch (logseqType) {
    case 'checkbox': return 'boolean';
    case 'date': return 'date';
    case 'node': return 'node';
    case 'number': return 'float';
    default: return 'text';
  }
}


