import type { Database } from 'sql.js';
import { queryOne } from '../db/sqlite';
import { deriveName } from '../adapters/nodeProjection';

export interface NodeSummary {
  id: string;
  title: string;
  icon: string | null;
  childCount: number;
  backlinkCount: number;
  hasChildren: boolean;
}

export function projectNodeSummary(db: Database, nodeId: string): NodeSummary | undefined {
  const node = queryOne<{ id: string; kind: string; content: string }>(
    db,
    'SELECT id, kind, content FROM node WHERE id = ?',
    [nodeId]
  );
  if (!node) return undefined;

  const stats = queryOne<{ child_count: number; backlink_count: number }>(
    db,
    'SELECT child_count, backlink_count FROM node_stats WHERE node_id = ?',
    [nodeId]
  );

  const childCount = stats?.child_count ?? 0;

  return {
    id: node.id,
    title: deriveName(node.content),
    icon: null,
    childCount,
    backlinkCount: stats?.backlink_count ?? 0,
    hasChildren: childCount > 0,
  };
}

export function hydrateNodeSummaries(db: Database, ids: string[]): NodeSummary[] {
  return ids
    .map((id) => projectNodeSummary(db, id))
    .filter((s): s is NodeSummary => s !== undefined);
}
