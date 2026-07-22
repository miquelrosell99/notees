/**
 * Build GraphNode-shaped results from the core SQLite derived store.
 */

import type { GraphNode, PaginatedResponse } from '@/types/api';
import { SYSTEM_CLASS_UUIDS } from '@/constants/systemProperties';
import { queryAll } from '../db/sqlite';
import { projectNode } from '../adapters/nodeProjection';
import type { WorkspaceStore } from '../store';
import type { IWorkspaceStoreClient } from '../worker/workerProtocol';

export function buildGraphNodes(store: WorkspaceStore): PaginatedResponse<GraphNode> {
  const db = store.getDb();

  const rows = queryAll<{ id: string }>(
    db,
    `SELECT id FROM node ORDER BY id`
  );

  const items: GraphNode[] = [];

  for (const row of rows) {
    const node = projectNode(store, row.id);
    if (!node) continue;

    items.push(nodeToGraphNode(store, node));
  }

  return {
    items,
    total: items.length,
    page: 1,
    page_size: items.length,
    has_next: false,
    has_prev: false,
  };
}

export async function buildGraphNodesFromClient(
  client: IWorkspaceStoreClient,
): Promise<PaginatedResponse<GraphNode>> {
  return client.query<PaginatedResponse<GraphNode>>('buildGraphNodes', []);
}

function nodeToGraphNode(_store: WorkspaceStore, node: ReturnType<typeof projectNode>): GraphNode {
  if (!node) {
    throw new Error('nodeToGraphNode called with undefined node');
  }

  const classIds = node.classes_uuid ?? [];

  return {
    uuid: node.uuid,
    name: node.name,
    type: node.is_page ? 'page' : 'block',
    class_uuids: classIds,
    properties: node.properties_uuid ?? {},
    is_daily: classIds.includes(SYSTEM_CLASS_UUIDS.day),
    is_class: node.is_class,
    is_monthly: classIds.includes(SYSTEM_CLASS_UUIDS.month),
    is_yearly: classIds.includes(SYSTEM_CLASS_UUIDS.year),
    icon: node.icon ?? undefined,
    created_at: node.create_date,
    backlink_count: node.backlink_count ?? 0,
    internal_link_count: 0,
    block_count: node.children?.length ?? (node.has_children ? 1 : 0),
    aliased_uuid: node.aliased_uuid,
  };
}
