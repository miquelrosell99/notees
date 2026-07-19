/**
 * Helpers for merging one page into another in the local-first core.
 */

import { queryAll } from '../db/sqlite';
import type { WorkspaceStore } from '../store';

function rewriteRefTargets(node: unknown, sourceId: string, targetId: string): unknown {
  if (Array.isArray(node)) {
    return node.map((child) => rewriteRefTargets(child, sourceId, targetId));
  }

  if (node !== null && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    if (obj.type === 'ref' && obj.targetId === sourceId) {
      return { ...obj, targetId: targetId };
    }
    const rewritten: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      rewritten[key] = rewriteRefTargets(value, sourceId, targetId);
    }
    return rewritten;
  }

  return node;
}

export function getBacklinkSourceIds(store: WorkspaceStore, targetId: string): string[] {
  const rows = queryAll<{ source_id: string }>(
    store.getDb(),
    'SELECT DISTINCT source_id FROM edge WHERE target_id = ? AND type = ?',
    [targetId, 'reference']
  );
  return rows.map((r) => r.source_id);
}

/**
 * Rewrite all `node_link` references to `sourceId` so they point to `targetId`.
 * Returns the list of affected node IDs.
 */
export function rewriteLinksToTarget(store: WorkspaceStore, sourceId: string, targetId: string): string[] {
  const sourceIds = getBacklinkSourceIds(store, sourceId);
  const affected: string[] = [];

  for (const nodeId of sourceIds) {
    const node = store.getNode(nodeId);
    if (!node) continue;

    let content: unknown[];
    try {
      content = JSON.parse(node.content) as unknown[];
    } catch {
      continue;
    }

    const rewritten = rewriteRefTargets(content, sourceId, targetId);
    if (JSON.stringify(rewritten) !== JSON.stringify(content)) {
      store.updateContentAst(nodeId, rewritten as unknown[]);
      affected.push(nodeId);
    }
  }

  return affected;
}
