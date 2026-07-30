import type { LinkedReference, BreadcrumbSegment, Node as ApiNode } from '@/types/api';
import { nodeNameToText } from '@/features/queries/hooks/useStringifyAST';
import type { WorkspaceStore } from '../store';
import { projectNode } from '../adapters/nodeProjection';

function findSourcePage(store: WorkspaceStore, sourceNodeId: string): ApiNode | undefined {
  const sourceNode = projectNode(store, sourceNodeId, 0);
  if (!sourceNode) return undefined;
  if (sourceNode.is_page) return sourceNode;

  const visited = new Set<string>();
  let currentId: string | null | undefined = sourceNode.parent_uuid;
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const parent = projectNode(store, currentId, 0);
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
    const node = projectNode(store, currentId, 0);
    if (!node) break;
    const parentId = node.parent_uuid;
    if (!parentId) break;
    const parent = projectNode(store, parentId, 0);
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

export function buildSyntheticRef(store: WorkspaceStore, sourceNodeId: string): LinkedReference | undefined {
  const sourceNode = projectNode(store, sourceNodeId, 0);
  if (!sourceNode) return undefined;
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

export function hydrateLinkedReferences(
  store: WorkspaceStore,
  _targetNodeUuid: string,
  sourceIds: string[]
): LinkedReference[] {
  return sourceIds
    .map((id) => buildSyntheticRef(store, id))
    .filter((ref): ref is LinkedReference => ref !== undefined);
}
