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

import { useCallback, useEffect, useState } from 'react';
import type { OperationRuntime } from '@/runtime';
import { getOperationRuntime } from '@/runtime';
import { getNode } from '@/runtime/graphHelpers';
import { getRuntimeEventBus } from '@/runtime/eventBus';
import type { Node } from '@/types/api';

/**
 * Read a node's live content name from the runtime projection, falling back
 * to `fallbackName` (typically the query-cache `node.name`) when the node is
 * not projected. The returned name is the JSON-stringified content AST, the
 * same format the block editor and inline renderers parse.
 */
export function readRuntimeName(
  runtime: OperationRuntime,
  nodeUuid: string | null | undefined,
  fallbackName: string,
): string {
  if (!nodeUuid) return fallbackName;
  const projected = getNode(runtime, nodeUuid);
  return projected ? JSON.stringify(projected.contentAST) : fallbackName;
}

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
 * Reads the runtime at call time; intended for read-only render paths that
 * re-render on edit/blur/remount (e.g. table cells, card titles).
 */
export function getRuntimeDisplayName(
  node: Node,
  runtime: OperationRuntime = getOperationRuntime(),
): string {
  return readRuntimeName(runtime, node.uuid, node.name);
}

/**
 * Subscribe to a node's live runtime content and return its current display
 * name. Re-renders the consumer when that specific block's content changes,
 * so observer surfaces (inline links, pills, breadcrumbs) stay fresh after
 * the referenced block is edited elsewhere. Falls back to `fallbackName`
 * (the query-cache name) when the node is not projected.
 *
 * Subscription is targeted via `subscribeToBlock`, so cost is proportional to
 * the number of rendered consumers, not the size of the graph.
 */
export function useRuntimeDisplayName(
  nodeUuid: string | null | undefined,
  fallbackName: string,
  runtime: OperationRuntime = getOperationRuntime(),
): string {
  const read = useCallback(
    () => readRuntimeName(runtime, nodeUuid, fallbackName),
    [runtime, nodeUuid, fallbackName],
  );
  const [name, setName] = useState<string>(read);

  useEffect(() => {
    setName(readRuntimeName(runtime, nodeUuid, fallbackName));
    if (!nodeUuid) return;
    return getRuntimeEventBus(runtime).subscribeToBlock(nodeUuid, () => {
      setName(readRuntimeName(runtime, nodeUuid, fallbackName));
    });
  }, [nodeUuid, fallbackName, runtime]);

  return name;
}
