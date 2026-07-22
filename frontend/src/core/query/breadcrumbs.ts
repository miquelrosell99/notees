/**
 * Build BreadcrumbItemResponse-shaped results from the core SQLite derived store.
 */

import type { BreadcrumbItemResponse } from '@/types/api';
import { projectNode } from '../adapters/nodeProjection';
import type { WorkspaceStore } from '../store';
import type { IWorkspaceStoreClient } from '../worker/workerProtocol';

export function buildBreadcrumbs(store: WorkspaceStore, nodeUuid: string): BreadcrumbItemResponse[] {
  const breadcrumbs: BreadcrumbItemResponse[] = [];
  const visited = new Set<string>();
  let currentId: string | null | undefined = nodeUuid;

  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const node = projectNode(store, currentId);
    if (!node) break;

    currentId = node.parent_uuid;
    if (!currentId) break;

    const parent = projectNode(store, currentId);
    if (!parent) break;

    breadcrumbs.push({
      uuid: parent.uuid,
      name: parent.name,
      display_name: parent.display_name ?? parent.name,
      icon: parent.icon ?? null,
      is_page: parent.is_page,
      parent_locked: parent.parent_locked ?? false,
    });
  }

  return breadcrumbs;
}

export async function buildBreadcrumbsFromClient(
  client: IWorkspaceStoreClient,
  nodeUuid: string
): Promise<BreadcrumbItemResponse[]> {
  return client.query<BreadcrumbItemResponse[]>('buildBreadcrumbs', [nodeUuid]);
}
