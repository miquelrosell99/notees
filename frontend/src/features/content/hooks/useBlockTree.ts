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

const EMPTY_STATES: Record<string, NodeUIState> = {};

export interface FlatNode {
  node: Node;
  depth: number;
  effectiveCollapsed: boolean;
  /** True for the trailing pseudo-block used to create new blocks in place. */
  isGhost?: boolean;
}

export interface UseBlockTreeOptions {
  maxDepth?: number;
  pagesOnly?: boolean;
  skipPages?: boolean;
  expandAll?: boolean;
  nodeUuid?: string;
  /** If false (default), a ghost block is appended as the last sibling. */
  readOnly?: boolean;
  /** If false, no ghost pseudo-blocks are generated regardless of readOnly. */
  showNewBlock?: boolean;
  /** If true, the root container is a block (focused block view), so the trailing
   *  root ghost is indented one level deeper and the per-parent child ghost for the
   *  root node is suppressed to avoid a duplicate placeholder. */
  rootIsBlock?: boolean;
}

const GHOST_PREFIX = '__ghost-';

export function isGhostId(uuid: string): boolean {
  return uuid.startsWith(GHOST_PREFIX);
}

export function buildGhostId(parentUuid: string): string {
  return `${GHOST_PREFIX}${parentUuid}`;
}

export function parseGhostParentUuid(ghostUuid: string): string | null {
  if (!isGhostId(ghostUuid)) return null;
  return ghostUuid.slice(GHOST_PREFIX.length);
}

export function isValidServerNodeId(uuid: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid);
}

export function createGhostFlatNode(parentUuid: string, depth: number): FlatNode {
  return {
    node: {
      uuid: buildGhostId(parentUuid),
      name: '',
      icon: null,
      color: null,
      parent_uuid: null,
      page_uuid: null,
      sequence: Number.MAX_SAFE_INTEGER,
      active: true,
      is_page: false,
      is_deleted: false,
      has_children: false,
      children: [],
      create_date: '',
      write_date: '',
      classes_uuid: [],
      tags_uuid: [],
      properties_uuid: {},
    },
    depth,
    effectiveCollapsed: false,
    isGhost: true,
  };
}

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

  useEffect(() => {
    if (!client) {
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
  }, [client, nodes, options, collapsedLookup]);

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
