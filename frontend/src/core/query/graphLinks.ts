/**
 * Build GraphLink-shaped results from the core SQLite derived store.
 */

import type { GraphLink } from '@/types/api';
import { queryAll } from '../db/sqlite';
import type { WorkspaceStore } from '../store';
import type { IWorkspaceStoreClient } from '../worker/workerProtocol';

type LinkScope = 'between' | 'touching';

export function buildGraphLinks(
  store: WorkspaceStore,
  nodeUuids: string[],
  scope: LinkScope = 'between'
): GraphLink[] {
  if (nodeUuids.length === 0) return [];

  const db = store.getDb();
  const uuidSet = new Set(nodeUuids);
  const links: GraphLink[] = [];
  const seen = new Set<string>();

  const addLink = (source: string, target: string, type: GraphLink['type']) => {
    const key = `${source}|${target}|${type}`;
    if (seen.has(key)) return;

    const sourceInSet = uuidSet.has(source);
    const targetInSet = uuidSet.has(target);

    if (scope === 'between' && (!sourceInSet || !targetInSet)) return;
    if (scope === 'touching' && !sourceInSet && !targetInSet) return;

    // The other end must exist in the store.
    if (!nodeExists(source) || !nodeExists(target)) return;

    seen.add(key);
    links.push({ source, target, type });
  };

  function nodeExists(nodeId: string): boolean {
    return store.getNode(nodeId) !== undefined;
  }

  // Parent links
  const parentRows = queryAll<{ id: string; parent_id: string | null }>(
    db,
    `SELECT id, parent_id FROM node WHERE parent_id IS NOT NULL`
  );
  for (const row of parentRows) {
    addLink(row.parent_id!, row.id, 'parent');
  }

  // Reference edges (deduplicated projection of node_link)
  const edgeRows = queryAll<{ source_id: string; target_id: string }>(
    db,
    `SELECT DISTINCT source_id, target_id FROM node_link`
  );
  for (const row of edgeRows) {
    addLink(row.source_id, row.target_id, 'reference');
  }

  // Class assignment links
  const classRows = queryAll<{ id: string; class_ids: string }>(
    db,
    `SELECT id, class_ids FROM node`
  );
  for (const row of classRows) {
    const classIds: string[] = JSON.parse(row.class_ids);
    for (const classId of classIds) {
      addLink(row.id, classId, 'class');
    }
  }

  // Property-reference links: property values whose JSON content is another node UUID.
  const propertyRows = queryAll<{ node_id: string; property_schema_id: string; value: string }>(
    db,
    `SELECT node_id, property_schema_id, value FROM property_value`
  );
  for (const row of propertyRows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.value);
    } catch {
      continue;
    }

    const targetId = typeof parsed === 'string' ? parsed : null;
    if (!targetId || !nodeExists(targetId)) continue;

    addLink(row.node_id, targetId, 'property-reference');
  }

  return links;
}

export async function buildGraphLinksFromClient(
  client: IWorkspaceStoreClient,
  nodeUuids: string[],
  scope: LinkScope = 'between',
): Promise<GraphLink[]> {
  return client.query<GraphLink[]>('buildGraphLinks', [nodeUuids, scope]);
}
