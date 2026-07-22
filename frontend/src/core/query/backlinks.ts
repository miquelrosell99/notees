/**
 * Build Backlink-shaped results from the core SQLite derived store.
 */

import type { Backlink, LinkType } from '@/types/api';
import { projectNode } from '../adapters/nodeProjection';
import type { WorkspaceStore } from '../store';
import type { IWorkspaceStoreClient } from '../worker/workerProtocol';

export function buildBacklinks(store: WorkspaceStore, nodeUuid: string): Backlink[] {
  const sourceIds = store.getBacklinks(nodeUuid);
  const backlinks: Backlink[] = [];

  for (const sourceId of sourceIds) {
    const sourceNode = projectNode(store, sourceId);
    if (!sourceNode) continue;

    const sourcePage = sourceNode.is_page ? sourceNode : findSourcePage(store, sourceId);
    const linkType: LinkType = sourceNode.is_page ? 'page' : 'block';

    backlinks.push({
      source_node_uuid: sourceNode.uuid,
      source_node_name: sourceNode.name,
      source_page_uuid: sourcePage?.uuid ?? null,
      source_page_name: sourcePage?.name ?? null,
      link_type: linkType,
      position: 0,
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

export async function buildBacklinksFromClient(
  client: IWorkspaceStoreClient,
  nodeUuid: string
): Promise<Backlink[]> {
  return client.query<Backlink[]>('buildBacklinks', [nodeUuid]);
}
