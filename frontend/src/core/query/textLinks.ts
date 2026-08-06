/**
 * Build TextLink-shaped results from the core SQLite derived store.
 */

import type { TextLink } from '@/types/api';
import { queryAll } from '../db/sqlite';
import { projectNode } from '../adapters/nodeProjection';
import type { WorkspaceStore } from '../store';
import type { IWorkspaceStoreClient } from '../worker/workerProtocol';

export function buildTextLinks(store: WorkspaceStore, nodeUuid: string): TextLink[] {
  const db = store.getDb();

  const rows = queryAll<{ id: string; target_id: string; label: string | null }>(
    db,
    `SELECT id, target_id, label
     FROM node_link
     WHERE source_id = ?
     ORDER BY created_at`,
    [nodeUuid]
  );

  return rows.map((row, index) => {
    const targetNode = projectNode(store, row.target_id);
    let name: string | null = targetNode?.name ?? null;

    if (!name) {
      name = row.label ?? null;
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

export async function buildTextLinksFromClient(
  client: IWorkspaceStoreClient,
  nodeUuid: string
): Promise<TextLink[]> {
  return client.query<TextLink[]>('buildTextLinks', [nodeUuid]);
}
