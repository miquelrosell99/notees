/**
 * listPages — local-first helper to fetch all pages from the core workspace store.
 *
 * Replaces the legacy `listNodes({ pages_only: true })` API call for action-time
 * page lookups (e.g. hierarchical path resolution).
 */

import { getWorkspaceStoreClient } from '@/core/adapters/workspaceStoreClientAdapter';
import type { Node } from '@/types/api';
import type { IWorkspaceStoreClient } from '@/core/worker/workerProtocol';

export async function listCorePagesFromClient(client: IWorkspaceStoreClient): Promise<Node[]> {
  return client.query<Node[]>('queryNodes', [{ isPage: true }]);
}

export async function listCorePagesAsync(workspaceUuid: string): Promise<Node[]> {
  const client = getWorkspaceStoreClient(workspaceUuid);
  if (!client) return [];
  return listCorePagesFromClient(client);
}
