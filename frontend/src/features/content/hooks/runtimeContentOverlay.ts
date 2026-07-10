/**
 * runtimeContentOverlay — project a query-cache node through the runtime's
 * live content projection.
 *
 * The runtime projection is the source of truth for just-edited content,
 * while the TanStack Query cache (`node.name`) can lag until the next
 * refetch. Read-only surfaces that render `node.name` directly (instead of
 * through `useBlockTree`, which already applies this overlay) should project
 * through these helpers so a freshly edited block does not render empty or
 * stale content until the page is reloaded.
 */

import type { OperationRuntime } from '@/runtime';
import { getOperationRuntime } from '@/runtime';
import { getNode } from '@/runtime/graphHelpers';
import type { Node } from '@/types/api';

/**
 * Return `node` with its content fields overlaid from the runtime projection
 * when one exists. Falls back to the query-cache node unchanged when the node
 * is not (yet) present in the runtime.
 */
export function overlayRuntimeContent(runtime: OperationRuntime, node: Node): Node {
  const projected = getNode(runtime, node.uuid);
  if (!projected) return node;
  return {
    ...node,
    name: JSON.stringify(projected.contentAST),
    icon: projected.icon ?? node.icon,
    color: projected.color ?? node.color,
    classes_uuid: projected.classIds,
    tags_uuid: projected.tagIds,
  };
}

/**
 * Read the live display name for a node, falling back to its cached name.
 * Reads the global runtime singleton; intended for read-only render paths
 * that re-render on edit/blur (e.g. table cells).
 */
export function getRuntimeDisplayName(
  node: Node,
  runtime: OperationRuntime = getOperationRuntime(),
): string {
  return overlayRuntimeContent(runtime, node).name;
}
