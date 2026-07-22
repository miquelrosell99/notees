/**
 * Build GraphData-shaped results from the core SQLite derived store.
 */

import type { GraphData } from '@/types/api';
import { buildGraphNodes } from './graphNodes';
import { buildGraphLinks } from './graphLinks';
import type { WorkspaceStore } from '../store';
import type { IWorkspaceStoreClient } from '../worker/workerProtocol';

export function buildGraphData(store: WorkspaceStore): GraphData {
  const nodesResponse = buildGraphNodes(store);
  const nodeUuids = nodesResponse.items.map((n) => n.uuid);
  const links = buildGraphLinks(store, nodeUuids, 'between');

  return {
    nodes: nodesResponse.items,
    links,
    total: nodesResponse.total,
    page: nodesResponse.page,
    page_size: nodesResponse.page_size,
    has_next: nodesResponse.has_next,
    has_prev: nodesResponse.has_prev,
  };
}

export async function buildGraphDataFromClient(
  client: IWorkspaceStoreClient,
): Promise<GraphData> {
  return client.query<GraphData>('buildGraphData', []);
}
