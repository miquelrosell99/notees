/**
 * Convert an OperationRuntime graph node into a minimal API Node for conflict diff.
 *
 * This is intentionally lossy: it preserves identity, content, hierarchy, and
 * timestamps, but omits backlinks/properties that are not needed for three-way
 * diff resolution.
 */

import { getOperationRuntime, getChildren } from '@/runtime';
import type { GraphNode } from '@/runtime/types';
import type { Node } from '@/types/api';

export function graphNodeToConflictNode(graphNode: GraphNode, depth = 0): Node {
  const runtime = getOperationRuntime();
  const children = depth < 10 ? getChildren(runtime, graphNode.blockId) : [];

  return {
    uuid: graphNode.blockId,
    name: JSON.stringify(graphNode.contentAST ?? []),
    icon: graphNode.icon ?? null,
    color: graphNode.color ?? null,
    parent_uuid: graphNode.parentId,
    page_uuid: null,
    sequence: graphNode.orderIndex,
    active: !graphNode.isDeleted,
    is_page: graphNode.isPage,
    is_deleted: graphNode.isDeleted,
    create_date: graphNode.createdAt,
    write_date: graphNode.updatedAt,
    classes_uuid: graphNode.classIds,
    tags_uuid: graphNode.tagIds,
    // Fold state is UI-only; diff views always show expanded for clarity.
    collapsed: false,
    children: children.map((child) => graphNodeToConflictNode(child, depth + 1)),
    has_children: children.length > 0 || !!graphNode.hasServerChildren,
  };
}
