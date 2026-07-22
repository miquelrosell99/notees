/**
 * Worker-side query helpers for operations that need raw SQL against the
 * worker-owned WorkspaceStore.
 *
 * These helpers are invoked through `IWorkspaceStoreClient.query` and are
 * implemented in both the real Web Worker and the jsdom inline fallback so
 * tests keep sharing the same synchronous store.
 */

import type { WorkspaceStore } from '../store';
import type { Node } from '@/types/api';
import { queryAll } from '../db/sqlite';
import { projectNode } from '../adapters/nodeProjection';
import { SYSTEM_CLASS_UUIDS } from '@/constants/systemProperties';

export function getTrashedNodes(
  store: WorkspaceStore,
  projectionDepth?: number
): Node[] {
  const rows = queryAll<{ id: string }>(
    store.getDb(),
    'SELECT id FROM node WHERE active = 0 ORDER BY updated_at DESC'
  );
  return rows
    .map((row) => projectNode(store, row.id, projectionDepth))
    .filter((n): n is Node => n !== undefined);
}

export function getArchivedPages(store: WorkspaceStore): Node[] {
  const rows = queryAll<{ id: string }>(
    store.getDb(),
    "SELECT id FROM node WHERE kind = 'page' AND active = 0 ORDER BY updated_at DESC"
  );
  return rows
    .map((row) => projectNode(store, row.id))
    .filter((n): n is Node => n !== undefined);
}

export function getPageAliases(
  store: WorkspaceStore,
  canonicalNodeId: string
): Node[] {
  const rows = queryAll<{ alias_node_id: string }>(
    store.getDb(),
    'SELECT alias_node_id FROM node_alias WHERE canonical_node_id = ?',
    [canonicalNodeId]
  );
  return rows
    .map((row) => projectNode(store, row.alias_node_id))
    .filter(
      (n): n is Node => n !== undefined && n.uuid !== canonicalNodeId
    );
}

export function getCommentNodes(
  store: WorkspaceStore,
  nodeUuid: string
): Node[] {
  const childIds = store.getChildren(nodeUuid);
  return childIds
    .map((childId) => projectNode(store, childId))
    .filter(
      (n): n is Node =>
        n !== undefined &&
        n.active !== false &&
        !!n.classes_uuid?.includes(SYSTEM_CLASS_UUIDS.comment)
    );
}
