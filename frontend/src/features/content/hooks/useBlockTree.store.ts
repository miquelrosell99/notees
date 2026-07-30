/**
 * useBlockTree.store — synchronous tree projection helpers that need the legacy
 * WorkspaceStore type.
 *
 * These are kept in a separate file so the production `useBlockTree` hook does
 * not import `WorkspaceStore` directly. Legacy callers and tests can still use
 * `buildFlatNodesFromStore` by importing from this module.
 */

import { projectNode } from '@/core/adapters/nodeProjection';
import type { WorkspaceStore } from '@/core/store';
import type { Node } from '@/types/api';
import {
  createGhostFlatNode,
  isValidServerNodeId,
  type FlatNode,
  type UseBlockTreeOptions,
} from './useBlockTree.shared';

/** @internal Exported for unit testing and legacy callers. */
export function buildFlatNodesFromStore(
  store: WorkspaceStore,
  nodes: Node[],
  options: UseBlockTreeOptions,
  collapsedLookup: (nodeUuid: string) => boolean | undefined,
): FlatNode[] {
  const {
    maxDepth = -1,
    pagesOnly = false,
    skipPages = false,
    expandAll = false,
    nodeUuid,
    readOnly = false,
    showNewBlock = true,
    rootIsBlock = false,
  } = options;

  const result: FlatNode[] = [];
  const visited = new Set<string>();
  const duplicateUuids: string[] = [];

  const flatten = (nodeUuids: string[], depth: number): void => {
    if (maxDepth >= 0 && depth > maxDepth) return;

    for (const nodeUuid of nodeUuids) {
      if (visited.has(nodeUuid)) {
        if (!duplicateUuids.includes(nodeUuid)) duplicateUuids.push(nodeUuid);
        continue;
      }
      visited.add(nodeUuid);

      const node = projectNode(store, nodeUuid, 0);
      if (!node) continue;
      if (node.is_deleted) continue;
      if (node.is_comment) continue;
      if (pagesOnly && !node.is_page) continue;
      if (skipPages && node.is_page) continue;

      const effectiveCollapsed = expandAll ? false : (collapsedLookup(nodeUuid) ?? false);
      result.push({ node, depth, effectiveCollapsed });

      if (!effectiveCollapsed && (maxDepth < 0 || depth < maxDepth)) {
        const children = store.getChildren(nodeUuid);
        flatten(children, depth + 1);

        const isRootLevel = depth === 0;
        if (
          !readOnly &&
          showNewBlock &&
          !pagesOnly &&
          !skipPages &&
          !(rootIsBlock && isRootLevel) &&
          isValidServerNodeId(nodeUuid)
        ) {
          result.push(createGhostFlatNode(nodeUuid, depth + 1));
        }
      }
    }
  };

  let rootUuids: string[];
  if (nodeUuid) {
    if (rootIsBlock && nodes.some((n) => n.uuid === nodeUuid)) {
      rootUuids = [nodeUuid];
    } else {
      rootUuids = store.getChildren(nodeUuid);
    }
  } else {
    const nodeMap = new Map(nodes.map((n) => [n.uuid, n]));
    rootUuids = nodes
      .filter((n) => !n.parent_uuid || !nodeMap.has(n.parent_uuid))
      .map((n) => n.uuid);
  }

  flatten(rootUuids, 0);

  if (!readOnly && showNewBlock && nodeUuid && isValidServerNodeId(nodeUuid)) {
    const rootGhostDepth = rootIsBlock ? 1 : 0;
    result.push(createGhostFlatNode(nodeUuid, rootGhostDepth));
  }

  if (duplicateUuids.length > 0 && process.env.NODE_ENV === 'development') {
    console.warn(
      '[useBlockTree] Skipped duplicate node UUID(s) in core projection:',
      duplicateUuids,
    );
  }

  return result;
}
