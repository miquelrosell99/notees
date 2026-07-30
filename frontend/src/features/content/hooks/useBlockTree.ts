/**
 * useBlockTree — Project a node tree from the local-first core store.
 *
 * This hook is the single source of truth for block tree projection.
 * It:
 * 1. Resolves the async worker-backed store client for the current workspace.
 * 2. Subscribes to structural/content changes.
 * 3. Computes a flat list by walking the store's node + child_order tables.
 *
 * When the core store client is not available, it falls back to the static prop
 * tree so read-only / test / legacy callers keep working.
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { useWorkspaceStoreClient } from '@/core/hooks';
import { useUIStateStore } from '@/features/sync';
import type { Node } from '@/types/api';
import type { NodeUIState } from '@/features/sync/stores/uiStateStore';
import type { IWorkspaceStoreClient } from '@/core/worker/workerProtocol';
import { useGraphQuery } from '@/core/graphQueries/hooks/useGraphQuery';
import { GetNodeTreeQuery } from '@/core/graphQueries/queries/GetNodeTreeQuery';
import { projectNodesFromClient } from '@/core/adapters/nodeProjection';
import {
  buildFlatNodesFromRows,
  getVisibleNodeIds,
} from '@/core/projections/NodeTreeProjection';
import {
  createGhostFlatNode,
  isValidServerNodeId,
  type FlatNode,
  type UseBlockTreeOptions,
} from './useBlockTree.shared';

// Re-export shared types and helpers so existing callers keep working.
export {
  isGhostId,
  buildGhostId,
  parseGhostParentUuid,
  isValidServerNodeId,
  createGhostFlatNode,
  type FlatNode,
  type UseBlockTreeOptions,
} from './useBlockTree.shared';

const EMPTY_STATES: Record<string, NodeUIState> = {};

/** Flatten a node tree statically (no core store). */
export function flattenNodes(
  nodes: Node[],
  maxDepth: number,
  pagesOnly: boolean,
  skipPages: boolean,
  collapsedLookup: (nodeUuid: string) => boolean | undefined,
  currentDepth = 0,
  expandAll = false,
  visited = new Set<string>(),
): FlatNode[] {
  const result: FlatNode[] = [];
  for (const node of nodes) {
    if (node.is_comment) continue;
    if (pagesOnly && !node.is_page) continue;
    if (skipPages && node.is_page) continue;
    if (visited.has(node.uuid)) continue;
    visited.add(node.uuid);

    const effectiveCollapsed = expandAll ? false : (collapsedLookup(node.uuid) ?? false);
    result.push({ node, depth: currentDepth, effectiveCollapsed });
    if (
      node.children &&
      node.children.length > 0 &&
      !effectiveCollapsed &&
      (maxDepth < 0 || currentDepth < maxDepth)
    ) {
      result.push(...flattenNodes(node.children, maxDepth, pagesOnly, skipPages, collapsedLookup, currentDepth + 1, expandAll, visited));
    }
  }

  return result;
}

async function buildFlatNodesFromClient(
  client: IWorkspaceStoreClient,
  nodes: Node[],
  options: UseBlockTreeOptions,
  collapsedLookup: (nodeUuid: string) => boolean | undefined,
): Promise<FlatNode[]> {
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

  const flatten = async (nodeUuids: string[], depth: number): Promise<void> => {
    if (maxDepth >= 0 && depth > maxDepth) return;

    for (const nodeUuid of nodeUuids) {
      if (visited.has(nodeUuid)) {
        if (!duplicateUuids.includes(nodeUuid)) duplicateUuids.push(nodeUuid);
        continue;
      }
      visited.add(nodeUuid);

      const node = await client.query<Node | undefined>('projectNode', [nodeUuid, 0]);
      if (!node) continue;
      if (node.is_deleted) continue;
      if (node.is_comment) continue;
      if (pagesOnly && !node.is_page) continue;
      if (skipPages && node.is_page) continue;

      const effectiveCollapsed = expandAll ? false : (collapsedLookup(nodeUuid) ?? false);
      result.push({ node, depth, effectiveCollapsed });

      if (!effectiveCollapsed && (maxDepth < 0 || depth < maxDepth)) {
        const children = await client.query<string[]>('getChildren', [nodeUuid]);
        await flatten(children, depth + 1);

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
      rootUuids = await client.query<string[]>('getChildren', [nodeUuid]);
    }
  } else {
    const nodeMap = new Map(nodes.map((n) => [n.uuid, n]));
    rootUuids = nodes
      .filter((n) => !n.parent_uuid || !nodeMap.has(n.parent_uuid))
      .map((n) => n.uuid);
  }

  await flatten(rootUuids, 0);

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

export function useBlockTree(
  nodes: Node[],
  options: UseBlockTreeOptions = {}
): { flatNodes: FlatNode[]; structureVersion: number } {
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
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const { client, isLoading } = useWorkspaceStoreClient(workspaceId ?? '');
  const workspaceStates = useUIStateStore(
    useMemo(() => (s) => (workspaceId ? s.states[workspaceId] ?? EMPTY_STATES : EMPTY_STATES), [workspaceId])
  );
  const collapsedLookup = useCallback(
    (nodeUuid: string) => workspaceStates[nodeUuid]?.collapsed,
    [workspaceStates]
  );

  const [structureVersion, setStructureVersion] = useState(0);
  const [projectedFlatNodes, setProjectedFlatNodes] = useState<FlatNode[]>([]);

  const treeQuery = useGraphQuery(
    GetNodeTreeQuery,
    { nodeUuid: nodeUuid ?? '', maxDepth },
    { enabled: !!client && !!nodeUuid }
  );

  // Query-driven path: fetch the visible subtree in one GetNodeTreeQuery
  // round-trip, then batch-project the legacy Node shape for visible ids.
  useEffect(() => {
    if (!client || !nodeUuid) {
      return;
    }
    if (!treeQuery.data) {
      return;
    }

    const treeData = treeQuery.data;
    let cancelled = false;
    const update = async (): Promise<void> => {
      try {
        const rows = treeData.rows;
        const visibleIds = getVisibleNodeIds(rows, options, collapsedLookup);
        const projectedNodes = await projectNodesFromClient(client, Array.from(visibleIds), 0);
        const nodeMap = new Map(projectedNodes.map((n) => [n.uuid, n]));
        const flat = buildFlatNodesFromRows(rows, nodeMap, options, collapsedLookup);
        if (!cancelled) {
          setProjectedFlatNodes(flat);
        }
      } catch (err) {
        // Ignore projection errors on unmount or when the store client is not
        // fully initialised (common in tests). The next query result or
        // subscription will retry.
        if (!cancelled && process.env.NODE_ENV === 'development') {
          console.warn('[useBlockTree] projection failed:', err);
        }
      }
    };

    update();
    return () => {
      cancelled = true;
    };
  }, [client, nodeUuid, treeQuery.data, options, collapsedLookup]);

  // Subscription-driven path for callers that pass a nodes prop without a
  // concrete root nodeUuid. This keeps the legacy static-tree behaviour intact.
  useEffect(() => {
    if (!client || nodeUuid) {
      return;
    }

    let cancelled = false;
    const update = async (): Promise<void> => {
      const flat = await buildFlatNodesFromClient(client, nodes, options, collapsedLookup);
      if (!cancelled) {
        setProjectedFlatNodes(flat);
      }
    };

    update();
    const unsubscribe = client.subscribe(null, () => {
      setStructureVersion((v) => v + 1);
      void update();
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [client, nodeUuid, nodes, options, collapsedLookup]);

  // Keep structureVersion moving when the batched subtree query refreshes.
  useEffect(() => {
    if (nodeUuid && treeQuery.data) {
      setStructureVersion((v) => v + 1);
    }
  }, [nodeUuid, treeQuery.data]);

  const flatNodes = useMemo(() => {
    if (!client || isLoading) {
      return flattenNodes(nodes, maxDepth, pagesOnly, skipPages, collapsedLookup, 0, expandAll);
    }
    return projectedFlatNodes;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    client,
    isLoading,
    nodes,
    maxDepth,
    pagesOnly,
    skipPages,
    expandAll,
    readOnly,
    showNewBlock,
    nodeUuid,
    rootIsBlock,
    projectedFlatNodes,
    collapsedLookup,
  ]);

  return { flatNodes, structureVersion };
}
