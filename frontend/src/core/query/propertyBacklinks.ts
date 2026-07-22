/**
 * Build PropertyBacklink-shaped results from the core SQLite derived store.
 */

import type { PropertyBacklink } from '@/types/api';
import { queryAll } from '../db/sqlite';
import { projectNode } from '../adapters/nodeProjection';
import type { WorkspaceStore } from '../store';
import type { IWorkspaceStoreClient } from '../worker/workerProtocol';

export function buildPropertyBacklinks(store: WorkspaceStore, nodeUuid: string): PropertyBacklink[] {
  const db = store.getDb();

  // Find every property_value whose JSON value equals the target UUID and whose
  // source node resolves to a page.
  const rows = queryAll<{ node_id: string; property_schema_id: string }>(
    db,
    `SELECT DISTINCT pv.node_id, pv.property_schema_id
     FROM property_value pv
     JOIN node n ON n.id = pv.node_id
     WHERE json_extract(pv.value, '$') = ?`,
    [nodeUuid]
  );

  const backlinks: PropertyBacklink[] = [];

  for (const row of rows) {
    const sourcePage = findSourcePage(store, row.node_id);
    if (!sourcePage) continue;

    const propertySchema = projectNode(store, row.property_schema_id);

    backlinks.push({
      source_page: sourcePage,
      property_uuid: row.property_schema_id,
      property_name: propertySchema?.name ?? row.property_schema_id,
    });
  }

  return backlinks;
}

function findSourcePage(store: WorkspaceStore, nodeId: string) {
  const visited = new Set<string>();
  let currentId: string | null | undefined = nodeId;

  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const node = projectNode(store, currentId);
    if (!node) break;
    if (node.is_page) return node;
    currentId = node.parent_uuid;
  }

  return undefined;
}

export async function buildPropertyBacklinksFromClient(
  client: IWorkspaceStoreClient,
  nodeUuid: string
): Promise<PropertyBacklink[]> {
  return client.query<PropertyBacklink[]>('buildPropertyBacklinks', [nodeUuid]);
}
