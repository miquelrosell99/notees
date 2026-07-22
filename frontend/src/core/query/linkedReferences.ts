/**
 * Build LinkedReference-shaped results from the core SQLite derived store.
 *
 * This is the local-first replacement for
 * `frontend/src/features/sync/local/buildOfflineLinkedReferences.ts`.
 */

import type { LinkedReference, LinkedReferencesResponse, BreadcrumbSegment, Node as ApiNode } from '@/types/api';
import { createEmptyQueryAST } from '@/types/queryAST';
import { autoFixSystemQuery } from '@/lib/systemQueryAutoFix';
import { nodeNameToText } from '@/features/queries/hooks/useStringifyAST';
import type { WorkspaceStore } from '../store';
import type { IWorkspaceStoreClient } from '../worker/workerProtocol';
import { queryNodes } from './queryNodes';
import { projectNode } from '../adapters/nodeProjection';

function findSourcePage(store: WorkspaceStore, sourceNodeId: string): ApiNode | undefined {
  const sourceNode = projectNode(store, sourceNodeId);
  if (!sourceNode) return undefined;
  if (sourceNode.is_page) return sourceNode;

  const visited = new Set<string>();
  let currentId: string | null | undefined = sourceNode.parent_uuid;
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const parent = projectNode(store, currentId);
    if (!parent) break;
    if (parent.is_page) return parent;
    currentId = parent.parent_uuid;
  }
  return undefined;
}

function buildBreadcrumbPath(store: WorkspaceStore, sourceNodeId: string): BreadcrumbSegment[] {
  const path: BreadcrumbSegment[] = [];
  const visited = new Set<string>();
  let currentId: string | null | undefined = sourceNodeId;

  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const node = projectNode(store, currentId);
    if (!node) break;
    const parentId = node.parent_uuid;
    if (!parentId) break;
    const parent = projectNode(store, parentId);
    if (!parent) break;
    path.unshift({
      node_uuid: parent.uuid,
      name: nodeNameToText(parent.name) || parent.uuid,
      is_property: false,
    });
    currentId = parentId;
  }

  return path;
}

function buildSyntheticRef(store: WorkspaceStore, sourceNodeId: string): LinkedReference {
  const sourceNode = projectNode(store, sourceNodeId)!;
  const sourcePage = findSourcePage(store, sourceNodeId);
  const breadcrumbPath = buildBreadcrumbPath(store, sourceNodeId);

  return {
    source_node: sourceNode as ApiNode,
    source_page: (sourcePage as ApiNode | undefined) ?? null,
    link_type: 'text',
    context: nodeNameToText(sourceNode.name) || '',
    breadcrumb_path: breadcrumbPath,
  };
}

/**
 * Evaluate linked references locally and return the same shape as the server endpoint.
 */
export function buildLinkedReferences(
  store: WorkspaceStore,
  nodeUuid: string,
  params?: { limit?: number; offset?: number },
): LinkedReferencesResponse {
  const baseAst = createEmptyQueryAST();
  const ast = autoFixSystemQuery(baseAst, 'linked_references', { nodeUuid });
  const matches = queryNodes(store, {
    ast,
    runtimeParams: { current_node_uuid: nodeUuid, current_node_id: nodeUuid },
    projectionDepth: 0,
  });

  const refs = matches.map((sourceNode) => buildSyntheticRef(store, sourceNode.uuid));

  const offset = params?.offset ?? 0;
  const limit = params?.limit ?? refs.length;
  const paginated = refs.slice(offset, offset + limit);

  return { linked_references: paginated, total_count: refs.length };
}

export async function buildLinkedReferencesFromClient(
  client: IWorkspaceStoreClient,
  nodeUuid: string,
  params?: { limit?: number; offset?: number }
): Promise<LinkedReferencesResponse> {
  return client.query<LinkedReferencesResponse>('buildLinkedReferences', [nodeUuid, params]);
}
