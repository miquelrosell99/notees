/**
 * Build LinkedReference-shaped results from the local node mirror.
 *
 * This is the offline counterpart to `GET /nodes/{uuid}/linked-references`.
 * It runs the linked-references QueryAST locally and synthesizes the metadata
 * the Linked References UI expects.
 */

import type { Node, LinkedReference, LinkedReferencesResponse, BreadcrumbSegment } from '@/types/api';
import { createEmptyQueryAST } from '@/types/queryAST';
import { autoFixSystemQuery } from '@/lib/systemQueryAutoFix';
import { nodeNameToText } from '@/features/queries';
import { queryNodesLocal } from './localQuery';
import { getAllNodes } from './localNodeStore';

/**
 * Find the nearest page ancestor of a node from the local mirror.
 */
function findSourcePage(sourceNode: Node, nodeByUuid: Map<string, Node>): Node | null {
  if (sourceNode.is_page) return sourceNode;
  let current: Node | undefined = sourceNode;
  const visited = new Set<string>();
  while (current?.parent_uuid && !visited.has(current.uuid)) {
    visited.add(current.uuid);
    const parent = nodeByUuid.get(current.parent_uuid);
    if (!parent) break;
    if (parent.is_page) return parent;
    current = parent;
  }
  return null;
}

function buildBreadcrumbPath(sourceNode: Node, nodeByUuid: Map<string, Node>): BreadcrumbSegment[] {
  const path: BreadcrumbSegment[] = [];
  const visited = new Set<string>();
  let current: Node | undefined = sourceNode;
  while (current?.parent_uuid && !visited.has(current.uuid)) {
    visited.add(current.uuid);
    const parent = nodeByUuid.get(current.parent_uuid);
    if (!parent) break;
    path.unshift({
      node_uuid: parent.uuid,
      name: nodeNameToText(parent.name) || parent.uuid,
      is_property: false,
    });
    current = parent;
  }
  return path;
}

function buildSyntheticRef(
  sourceNode: Node,
  nodeByUuid: Map<string, Node>,
): LinkedReference {
  const sourcePage = findSourcePage(sourceNode, nodeByUuid);
  const breadcrumbPath = buildBreadcrumbPath(sourceNode, nodeByUuid);

  return {
    source_node: sourceNode,
    source_page: sourcePage,
    link_type: 'text',
    context: nodeNameToText(sourceNode.name) || '',
    breadcrumb_path: breadcrumbPath,
  };
}

/**
 * Evaluate linked references locally and return the same shape as the server endpoint.
 */
export async function buildOfflineLinkedReferences(
  workspaceUuid: string,
  nodeUuid: string,
  params?: { limit?: number; offset?: number },
): Promise<LinkedReferencesResponse> {
  const baseAst = createEmptyQueryAST();
  const ast = autoFixSystemQuery(baseAst, 'linked_references', { nodeUuid });
  const matches = await queryNodesLocal(workspaceUuid, {
    ast,
    runtimeParams: { current_node_uuid: nodeUuid, current_node_id: nodeUuid },
  });

  const allNodes = await getAllNodes(workspaceUuid);
  const nodeByUuid = new Map(allNodes.map((n) => [n.uuid, n]));

  const refs = matches.map((sourceNode) => buildSyntheticRef(sourceNode, nodeByUuid));

  const offset = params?.offset ?? 0;
  const limit = params?.limit ?? refs.length;
  const paginated = refs.slice(offset, offset + limit);

  return { linked_references: paginated, total_count: refs.length };
}
