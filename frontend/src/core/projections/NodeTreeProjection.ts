import { projectNode } from '@/core/adapters/nodeProjection';
import type { WorkspaceStore } from '@/core/store';
import type { Node } from '@/types/api';
import {
  createGhostFlatNode,
  isValidServerNodeId,
  type FlatNode,
  type UseBlockTreeOptions,
} from '@/features/content/hooks/useBlockTree.shared';
import type { TreeNodeRow } from '@/core/graphQueries/queries/GetNodeTreeQuery';

function buildChildrenByParent(rows: TreeNodeRow[]): Map<string, TreeNodeRow[]> {
  const map = new Map<string, TreeNodeRow[]>();
  for (const row of rows) {
    if (!row.parentId) continue;
    let children = map.get(row.parentId);
    if (!children) {
      children = [];
      map.set(row.parentId, children);
    }
    children.push(row);
  }
  for (const children of map.values()) {
    children.sort((a, b) => (a.position ?? '').localeCompare(b.position ?? ''));
  }
  return map;
}

function resolveRootUuids(
  rows: TreeNodeRow[],
  nodeUuid: string | undefined,
  nodeMap: Map<string, Node>
): string[] {
  if (!nodeUuid) {
    return rows.filter((r) => !r.parentId).map((r) => r.id);
  }

  if (nodeMap.has(nodeUuid)) {
    return [nodeUuid];
  }

  const childrenByParent = buildChildrenByParent(rows);
  return childrenByParent.get(nodeUuid)?.map((r) => r.id) ?? [];
}

/**
 * Compute the set of node ids that will be rendered from the tree rows.
 * This mirrors the visibility logic in buildFlatNodesFromRows so callers can
 * batch-project the legacy Node shape for exactly the visible nodes.
 */
export function getVisibleNodeIds(
  rows: TreeNodeRow[],
  options: UseBlockTreeOptions,
  collapsedLookup: (nodeUuid: string) => boolean | undefined
): Set<string> {
  const {
    maxDepth = -1,
    pagesOnly = false,
    skipPages = false,
    expandAll = false,
    nodeUuid,
    rootIsBlock = false,
  } = options;

  const rowMap = new Map(rows.map((r) => [r.id, r]));
  const childrenByParent = buildChildrenByParent(rows);
  const rootRow = nodeUuid ? rowMap.get(nodeUuid) : undefined;
  const includeRoot = !!rootRow && rootIsBlock;

  let rootUuids: string[];
  if (nodeUuid) {
    if (includeRoot) {
      rootUuids = [nodeUuid];
    } else {
      rootUuids = childrenByParent.get(nodeUuid)?.map((r) => r.id) ?? [];
    }
  } else {
    rootUuids = rows.filter((r) => !r.parentId).map((r) => r.id);
  }

  const visible = new Set<string>();

  const walk = (ids: string[], depth: number): void => {
    if (maxDepth >= 0 && depth > maxDepth) return;
    for (const id of ids) {
      if (visible.has(id)) continue;
      visible.add(id);

      const row = rowMap.get(id);
      if (!row) continue;
      if (pagesOnly && row.kind !== 'page') continue;
      if (skipPages && row.kind === 'page') continue;

      const effectiveCollapsed = expandAll ? false : (collapsedLookup(id) ?? false);
      if (!effectiveCollapsed && (maxDepth < 0 || depth < maxDepth)) {
        const childRows = childrenByParent.get(id) ?? [];
        walk(
          childRows.map((r) => r.id),
          depth + 1
        );
      }
    }
  };

  walk(rootUuids, 0);
  return visible;
}

/**
 * Build FlatNode[] from tree rows and a pre-fetched map of legacy Node shapes.
 * Children are taken from the tree rows, not from recursive projection.
 */
export function buildFlatNodesFromRows(
  rows: TreeNodeRow[],
  nodeMap: Map<string, Node>,
  options: UseBlockTreeOptions,
  collapsedLookup: (nodeUuid: string) => boolean | undefined
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

  const childrenByParent = buildChildrenByParent(rows);
  const rootUuids = resolveRootUuids(rows, nodeUuid, nodeMap);

  const result: FlatNode[] = [];
  const visited = new Set<string>();
  const duplicateUuids: string[] = [];

  const flatten = (ids: string[], depth: number): void => {
    if (maxDepth >= 0 && depth > maxDepth) return;

    for (const id of ids) {
      if (visited.has(id)) {
        if (!duplicateUuids.includes(id)) duplicateUuids.push(id);
        continue;
      }
      visited.add(id);

      const node = nodeMap.get(id);
      if (!node) continue;
      if (node.is_deleted) continue;
      if (node.is_comment) continue;
      if (pagesOnly && !node.is_page) continue;
      if (skipPages && node.is_page) continue;

      const effectiveCollapsed = expandAll ? false : (collapsedLookup(id) ?? false);
      result.push({ node, depth, effectiveCollapsed });

      if (!effectiveCollapsed && (maxDepth < 0 || depth < maxDepth)) {
        const childRows = childrenByParent.get(id) ?? [];
        flatten(
          childRows.map((r) => r.id),
          depth + 1
        );

        const isRootLevel = depth === 0;
        if (
          !readOnly &&
          showNewBlock &&
          !pagesOnly &&
          !skipPages &&
          !(rootIsBlock && isRootLevel) &&
          isValidServerNodeId(id)
        ) {
          result.push(createGhostFlatNode(id, depth + 1));
        }
      }
    }
  };

  flatten(rootUuids, 0);

  if (!readOnly && showNewBlock && nodeUuid && isValidServerNodeId(nodeUuid)) {
    const rootGhostDepth = rootIsBlock ? 1 : 0;
    result.push(createGhostFlatNode(nodeUuid, rootGhostDepth));
  }

  if (duplicateUuids.length > 0 && process.env.NODE_ENV === 'development') {
    console.warn(
      '[NodeTreeProjection] Skipped duplicate node UUID(s) in tree projection:',
      duplicateUuids
    );
  }

  return result;
}

/**
 * Synchronous convenience wrapper that projects the visible nodes from a
 * WorkspaceStore. Useful in tests and legacy callers that already hold the
 * store directly.
 */
export function buildFlatNodesFromStore(
  store: WorkspaceStore,
  rows: TreeNodeRow[],
  options: UseBlockTreeOptions,
  collapsedLookup: (nodeUuid: string) => boolean | undefined
): FlatNode[] {
  const visibleIds = getVisibleNodeIds(rows, options, collapsedLookup);
  const nodeMap = new Map<string, Node>();
  for (const id of visibleIds) {
    const node = projectNode(store, id, 0);
    if (node) nodeMap.set(id, node);
  }
  return buildFlatNodesFromRows(rows, nodeMap, options, collapsedLookup);
}
