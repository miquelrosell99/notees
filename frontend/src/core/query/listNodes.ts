/**
 * listNodes — worker-side node listing for collection/list views.
 *
 * Runs inside the worker (or the inline test shim) so the raw sql.js Database
 * never has to cross the thread boundary.
 */

import type { Node } from '@/types/api';
import { projectNode } from '../adapters/nodeProjection';
import { queryAll } from '../db/sqlite';
import type { WorkspaceStore } from '../store';

const DEFAULT_NODES_LIMIT = 100;

export interface ListNodesFilters {
  pages_only?: boolean;
  parent_uuid?: string;
  tag_uuid?: string;
  page_size?: number;
}

export function listNodes(store: WorkspaceStore, filters?: ListNodesFilters | null): Node[] {
  const db = store.getDb();
  const workspaceId = store.getWorkspaceId();

  const where: string[] = ['workspace_id = ?'];
  const params: (string | number)[] = [workspaceId];

  if (filters?.pages_only) {
    where.push("kind = 'page'");
  }

  if (filters?.parent_uuid) {
    where.push('parent_id = ?');
    params.push(filters.parent_uuid);
  }

  if (filters?.tag_uuid) {
    where.push('EXISTS (SELECT 1 FROM json_each(class_ids) WHERE value = ?)');
    params.push(filters.tag_uuid);
  }

  const limit = filters?.page_size ?? DEFAULT_NODES_LIMIT;

  const rows = queryAll<{ id: string }>(
    db,
    `SELECT id FROM node WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?`,
    [...params, limit]
  );

  return rows
    .map((row) => projectNode(store, row.id))
    .filter((n): n is Node => n !== undefined);
}
