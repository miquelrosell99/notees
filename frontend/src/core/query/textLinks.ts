/**
 * Build TextLink-shaped results from the core SQLite derived store.
 */

import type { TextLink } from '@/types/api';
import { queryAll } from '../db/sqlite';
import { projectNode } from '../adapters/nodeProjection';
import type { WorkspaceStore } from '../store';

export function buildTextLinks(store: WorkspaceStore, nodeUuid: string): TextLink[] {
  const db = store.getDb();

  const rows = queryAll<{ id: string; target_id: string; metadata: string | null }>(
    db,
    `SELECT id, target_id, metadata
     FROM edge
     WHERE source_id = ? AND type = ?
     ORDER BY created_at`,
    [nodeUuid, 'reference']
  );

  return rows.map((row, index) => {
    const targetNode = projectNode(store, row.target_id);
    let name: string | null = targetNode?.name ?? null;

    if (!name && row.metadata) {
      try {
        const parsed = JSON.parse(row.metadata) as { label?: string | null };
        name = parsed.label ?? null;
      } catch {
        // ignore malformed metadata
      }
    }

    return {
      uuid: row.id,
      source_node_uuid: nodeUuid,
      target_node_uuid: row.target_id,
      position: index,
      name,
    };
  });
}
