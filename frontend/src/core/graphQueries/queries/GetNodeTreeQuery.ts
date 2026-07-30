import type { Database } from 'sql.js';
import type { GraphQuery } from '../GraphQuery';
import { queryAll } from '../../db/sqlite';

export interface TreeNodeRow {
  id: string;
  parentId: string | null;
  depth: number;
  kind: string;
  content: string;
  classIds: string[];
  active: number;
  position: string | null;
}

interface RawTreeNodeRow {
  id: string;
  parentId: string | null;
  depth: number;
  kind: string;
  content: string;
  classIds: string;
  active: number;
  position: string | null;
}

export interface GetNodeTreeInput {
  nodeUuid: string;
  maxDepth: number;
}

export interface GetNodeTreeOutput {
  rows: TreeNodeRow[];
}

function parseClassIds(raw: string): string[] {
  try {
    return JSON.parse(raw) as string[];
  } catch {
    return [];
  }
}

function getNodeTree(db: Database, nodeUuid: string, maxDepth: number): TreeNodeRow[] {
  const rows = queryAll<RawTreeNodeRow>(
    db,
    `WITH RECURSIVE tree AS (
      SELECT
        n.id,
        n.parent_id AS parentId,
        0 AS depth,
        n.kind,
        n.content,
        n.class_ids AS classIds,
        n.active,
        NULL AS position,
        '/' || n.id AS sortPath
      FROM node n
      WHERE n.id = ?

      UNION ALL

      SELECT
        n.id,
        t.id AS parentId,
        t.depth + 1,
        n.kind,
        n.content,
        n.class_ids,
        n.active,
        nco.position,
        t.sortPath || '/' || nco.position || ':' || n.id
      FROM tree t
      JOIN node_child_order nco ON nco.parent_id = t.id
      JOIN node n ON n.id = nco.child_id
      WHERE ? < 0 OR t.depth < ?
    )
    SELECT
      id,
      parentId,
      depth,
      kind,
      content,
      classIds,
      active,
      position
    FROM tree
    ORDER BY sortPath`,
    [nodeUuid, maxDepth, maxDepth]
  );

  return rows.map((row) => ({
    ...row,
    classIds: parseClassIds(row.classIds),
  }));
}

export const GetNodeTreeQuery: GraphQuery<GetNodeTreeInput, GetNodeTreeOutput> = {
  name: 'GetNodeTreeQuery',
  cacheKey: (i) => `node-tree:${i.nodeUuid}:${i.maxDepth}`,
  execute(store, i) {
    return { rows: getNodeTree(store.getDb(), i.nodeUuid, i.maxDepth) };
  },
  shouldInvalidate(i, n) {
    return n.scope === 'tree' || n.scope === 'all' || n.nodeId === i.nodeUuid;
  },
};
